import {
  billingCheckouts,
  wallets,
  walletTransactions,
  subscriptions,
  type Tier,
  type PremiumFeature,
  TIER_LIMITS,
  type Subscription,
} from "@shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db";

export const BILLING_CURRENCY = "eur";

export interface WalletTransactionSummary {
  id: number;
  kind: string;
  amountCents: number;
  currency: string;
  description: string;
  source: string;
  reference: string | null;
  createdAt: string;
}

export interface WalletSummary {
  balanceCents: number;
  currency: string;
  transactions: WalletTransactionSummary[];
}

async function ensureWallet(userId: number) {
  const db = getDb();
  const [existing] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (existing) return existing;

  const now = new Date().toISOString();
  await db.insert(wallets).values({
    userId,
    balanceCents: 0,
    currency: BILLING_CURRENCY,
    updatedAt: now,
  });

  const [created] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return created;
}

async function ensureWalletInTx(tx: any, userId: number) {
  const [existing] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (existing) return existing;

  const now = new Date().toISOString();
  await tx.insert(wallets).values({
    userId,
    balanceCents: 0,
    currency: BILLING_CURRENCY,
    updatedAt: now,
  });

  const [created] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return created;
}

export async function getWalletSummary(userId: number): Promise<WalletSummary> {
  const wallet = await ensureWallet(userId);
  const transactions = await getDb()
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId))
    .orderBy(desc(walletTransactions.id))
    .limit(20);

  return {
    balanceCents: wallet?.balanceCents ?? 0,
    currency: wallet?.currency ?? BILLING_CURRENCY,
    transactions: transactions.map((item) => ({
      id: item.id,
      kind: item.kind,
      amountCents: item.amountCents,
      currency: item.currency,
      description: item.description,
      source: item.source,
      reference: item.reference ?? null,
      createdAt: item.createdAt,
    })),
  };
}

export async function createPendingCheckout(params: {
  sessionId: string;
  userId: number;
  amountCents: number;
  checkoutUrl: string | null;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  await getDb()
    .insert(billingCheckouts)
    .values({
      sessionId: params.sessionId,
      userId: params.userId,
      amountCents: params.amountCents,
      currency: BILLING_CURRENCY,
      status: "pending",
      stripePaymentStatus: "unpaid",
      checkoutUrl: params.checkoutUrl,
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: billingCheckouts.sessionId,
      set: {
        amountCents: params.amountCents,
        checkoutUrl: params.checkoutUrl,
        metadata: params.metadata ?? {},
        updatedAt: now,
      },
    });
}

export async function markCheckoutAsCompleted(params: {
  sessionId: string;
  userId: number;
  amountCents: number;
  stripePaymentStatus: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ applied: boolean; balanceCents: number }> {
  return getDb().transaction(async (tx: any) => {
    const [existingCheckout] = await tx
      .select()
      .from(billingCheckouts)
      .where(eq(billingCheckouts.sessionId, params.sessionId))
      .limit(1);

    if (existingCheckout?.status === "completed") {
      const wallet = await ensureWalletInTx(tx, params.userId);
      return { applied: false, balanceCents: wallet?.balanceCents ?? 0 };
    }

    await ensureWalletInTx(tx, params.userId);
    const now = new Date().toISOString();

    await tx
      .insert(billingCheckouts)
      .values({
        sessionId: params.sessionId,
        userId: params.userId,
        amountCents: params.amountCents,
        currency: BILLING_CURRENCY,
        status: "completed",
        stripePaymentStatus: params.stripePaymentStatus,
        checkoutUrl: existingCheckout?.checkoutUrl ?? null,
        metadata: params.metadata ?? existingCheckout?.metadata ?? {},
        createdAt: existingCheckout?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: billingCheckouts.sessionId,
        set: {
          userId: params.userId,
          amountCents: params.amountCents,
          status: "completed",
          stripePaymentStatus: params.stripePaymentStatus,
          metadata: params.metadata ?? existingCheckout?.metadata ?? {},
          updatedAt: now,
        },
      });

    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${params.amountCents}`,
        updatedAt: now,
      })
      .where(eq(wallets.userId, params.userId));

    await tx.insert(walletTransactions).values({
      userId: params.userId,
      kind: "credit",
      amountCents: params.amountCents,
      currency: BILLING_CURRENCY,
      description: "Ricarica credito BilancioAI",
      source: "stripe_checkout",
      reference: params.sessionId,
      metadata: params.metadata ?? {},
      createdAt: now,
    });

    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, params.userId)).limit(1);
    return { applied: true, balanceCents: wallet?.balanceCents ?? 0 };
  });
}

export async function consumeBusinessAnalysisCredits(params: {
  userId: number;
  amountCents: number;
  reference: string;
  companyId?: string;
  taxCode?: string;
}): Promise<
  | { ok: true; balanceCents: number }
  | { ok: false; balanceCents: number; missingCents: number }
> {
  return getDb().transaction(async (tx: any) => {
    const wallet = await ensureWalletInTx(tx, params.userId);
    const [existingDebit] = await tx
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, params.userId),
          eq(walletTransactions.source, "business_analysis"),
          eq(walletTransactions.reference, params.reference),
        ),
      )
      .limit(1);

    if (existingDebit) {
      const [currentWallet] = await tx.select().from(wallets).where(eq(wallets.userId, params.userId)).limit(1);
      return { ok: true as const, balanceCents: currentWallet?.balanceCents ?? wallet?.balanceCents ?? 0 };
    }

    const currentBalance = wallet?.balanceCents ?? 0;
    if (currentBalance < params.amountCents) {
      return {
        ok: false as const,
        balanceCents: currentBalance,
        missingCents: params.amountCents - currentBalance,
      };
    }

    const now = new Date().toISOString();
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} - ${params.amountCents}`,
        updatedAt: now,
      })
      .where(eq(wallets.userId, params.userId));

    await tx.insert(walletTransactions).values({
      userId: params.userId,
      kind: "debit",
      amountCents: params.amountCents,
      currency: BILLING_CURRENCY,
      description: "Analisi business bilancio ottico",
      source: "business_analysis",
      reference: params.reference,
      metadata: {
        companyId: params.companyId ?? null,
        taxCode: params.taxCode ?? null,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      balanceCents: currentBalance - params.amountCents,
    };
  });
}

export async function refundBusinessAnalysisCredits(params: {
  userId: number;
  amountCents: number;
  reference: string;
  reason: string;
  companyId?: string;
  taxCode?: string;
}): Promise<void> {
  await getDb().transaction(async (tx: any) => {
    await ensureWalletInTx(tx, params.userId);
    const refundReference = `refund:${params.reference}`;
    const [existingRefund] = await tx
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, params.userId),
          eq(walletTransactions.source, "business_analysis_refund"),
          eq(walletTransactions.reference, refundReference),
        ),
      )
      .limit(1);

    if (existingRefund) {
      return;
    }

    const now = new Date().toISOString();
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${params.amountCents}`,
        updatedAt: now,
      })
      .where(eq(wallets.userId, params.userId));

    await tx.insert(walletTransactions).values({
      userId: params.userId,
      kind: "refund",
      amountCents: params.amountCents,
      currency: BILLING_CURRENCY,
      description: params.reason,
      source: "business_analysis_refund",
      reference: refundReference,
      metadata: {
        originalReference: params.reference,
        companyId: params.companyId ?? null,
        taxCode: params.taxCode ?? null,
      },
      createdAt: now,
    });
  });
}

// ── Subscription & Tier helpers ──

export async function getActiveSubscription(userId: number): Promise<Subscription | null> {
  const [sub] = await getDb()
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
      ),
    )
    .limit(1);
  return sub ?? null;
}

export async function getUserTier(userId: number): Promise<Tier> {
  const sub = await getActiveSubscription(userId);
  if (!sub) return "free";
  return sub.tier as Tier;
}

export function canAccessFeature(tier: Tier, feature: PremiumFeature): boolean {
  if (tier === "pro" || tier === "business") return true;
  return false;
}

export async function consumeSubscriptionAnalysis(userId: number): Promise<
  | { ok: true; analysesUsed: number; analysesLimit: number }
  | { ok: false; reason: "no_subscription" | "limit_reached"; analysesUsed?: number; analysesLimit?: number }
> {
  const sub = await getActiveSubscription(userId);
  if (!sub) return { ok: false, reason: "no_subscription" };

  if (sub.analysesUsed >= sub.analysesLimit) {
    return { ok: false, reason: "limit_reached", analysesUsed: sub.analysesUsed, analysesLimit: sub.analysesLimit };
  }

  const now = new Date().toISOString();
  await getDb()
    .update(subscriptions)
    .set({
      analysesUsed: sql`${subscriptions.analysesUsed} + 1`,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, sub.id));

  return { ok: true, analysesUsed: sub.analysesUsed + 1, analysesLimit: sub.analysesLimit };
}

export async function createSubscription(params: {
  userId: number;
  tier: "pro" | "business";
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}): Promise<Subscription> {
  const now = new Date().toISOString();
  const limit = TIER_LIMITS[params.tier].analysesPerMonth;

  const [sub] = await getDb()
    .insert(subscriptions)
    .values({
      userId: params.userId,
      tier: params.tier,
      stripeSubscriptionId: params.stripeSubscriptionId,
      stripeCustomerId: params.stripeCustomerId,
      status: "active",
      currentPeriodStart: params.currentPeriodStart,
      currentPeriodEnd: params.currentPeriodEnd,
      analysesUsed: 0,
      analysesLimit: limit,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return sub;
}

export async function resetSubscriptionAnalyses(stripeSubscriptionId: string, periodStart: string, periodEnd: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb()
    .update(subscriptions)
    .set({
      analysesUsed: 0,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      updatedAt: now,
    })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
}

export async function cancelSubscription(stripeSubscriptionId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb()
    .update(subscriptions)
    .set({ status: "canceled", updatedAt: now })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
}
