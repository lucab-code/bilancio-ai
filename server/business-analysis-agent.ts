type CompanyDescriptionPayload = {
  description: string;
  sources: Array<{ title: string; url: string }>;
  keyProducts: Array<{ name: string; tagline: string | null; imageUrl: string | null; pageUrl: string | null }>;
  version: string;
};

type RecommendationPayload = {
  workingCapitalDebt: any;
  recommendations: any[];
  ceoBrief?: any;
};

type BusinessAnalysisAgentResult = {
  companyDetails: any;
  financialData: any;
  insights: any;
  documentSource: "openapi" | "user_upload" | "mixed";
};

type BusinessAnalysisAgentDependencies = {
  businessInsightsVersion: string;
  businessInsightsBudgetMs: number;
  buildFallbackInsights: (financialData: any, companyDetails?: any) => any;
  generatePrivateEquityCompanyDescription: (companyDetails: any, financialData: any) => Promise<CompanyDescriptionPayload>;
  generateMarketBenchmarks: (companyDetails: any, financialData: any, description: string) => Promise<any>;
  generateWorkingCapitalDebtAndRecommendations: (
    companyDetails: any,
    financialData: any,
    marketBenchmarks: any,
    description: string,
  ) => Promise<RecommendationPayload>;
  generateBusinessCeoBrief: (
    companyDetails: any,
    financialData: any,
    marketBenchmarks: any,
    workingCapitalDebt: any,
    recommendations: any[],
    description: string,
  ) => Promise<any>;
  persistOpenApiSnapshot?: (result: BusinessAnalysisAgentResult) => Promise<void>;
  persistAnalysisHistory: (entry: {
    userId: number;
    mode: "business";
    companyName: string;
    companyId: string;
    taxCode: string | null;
    address: string | null;
    companyDetails: any;
    financialData: any;
  }) => Promise<void>;
};

type RunBusinessAnalysisAgentParams = {
  userId: number;
  companyId: string;
  taxCode: string | null;
  companyDetails: any;
  financialData: any;
  documentSource: "openapi" | "user_upload" | "mixed";
};

function hasTimeFor(deadline: number, reserveMs: number): boolean {
  return Date.now() < deadline - reserveMs;
}

export async function runBusinessAnalysisAgent(
  params: RunBusinessAnalysisAgentParams,
  deps: BusinessAnalysisAgentDependencies,
): Promise<BusinessAnalysisAgentResult> {
  const {
    userId,
    companyId,
    taxCode,
    companyDetails,
    financialData,
    documentSource,
  } = params;
  const deadline = Date.now() + deps.businessInsightsBudgetMs;
  const fallbackInsights = deps.buildFallbackInsights(financialData, companyDetails);

  const descriptionPayload = {
    description: "",
    sources: [] as Array<{ title: string; url: string }>,
    keyProducts: [] as Array<{ name: string; tagline: string | null; imageUrl: string | null; pageUrl: string | null }>,
    version: "skip",
  };

  const marketBenchmarks = hasTimeFor(deadline, 12000)
    ? await deps.generateMarketBenchmarks(
        companyDetails,
        financialData,
        "",
      )
    : fallbackInsights.marketBenchmarks;

  const recommendationPayload = hasTimeFor(deadline, 7000)
    ? await deps.generateWorkingCapitalDebtAndRecommendations(
        companyDetails,
        financialData,
        marketBenchmarks,
        descriptionPayload.description,
      )
    : {
        workingCapitalDebt: fallbackInsights.workingCapitalDebt,
        recommendations: fallbackInsights.recommendations,
        ceoBrief: fallbackInsights.ceoBrief,
      };

  const ceoBrief = recommendationPayload?.ceoBrief
    ? recommendationPayload.ceoBrief
    : hasTimeFor(deadline, 3000)
    ? await deps.generateBusinessCeoBrief(
        companyDetails,
        financialData,
        marketBenchmarks,
        recommendationPayload.workingCapitalDebt,
        recommendationPayload.recommendations,
        descriptionPayload.description,
      )
    : fallbackInsights.ceoBrief;

  const insights = {
    version: deps.businessInsightsVersion,
    marketBenchmarks,
    workingCapitalDebt: recommendationPayload.workingCapitalDebt,
    recommendations: recommendationPayload.recommendations,
    ceoBrief,
  };
  const financialDataWithInsights = {
    ...financialData,
    insightsVersion: deps.businessInsightsVersion,
    insights,
  };
  const result: BusinessAnalysisAgentResult = {
    companyDetails: {
      ...companyDetails,
      aiDescription: descriptionPayload.description,
      aiDescriptionSources: descriptionPayload.sources,
      aiKeyProducts: descriptionPayload.keyProducts,
      aiDescriptionVersion: descriptionPayload.version,
    },
    financialData: financialDataWithInsights,
    insights,
    documentSource,
  };

  if (documentSource === "openapi" && deps.persistOpenApiSnapshot) {
    await deps.persistOpenApiSnapshot(result);
  }

  await deps.persistAnalysisHistory({
    userId,
    mode: "business",
    companyName: companyDetails?.denominazione || companyId,
    companyId,
    taxCode,
    address: companyDetails?.indirizzo || null,
    companyDetails: result.companyDetails,
    financialData: result.financialData,
  });

  return result;
}
