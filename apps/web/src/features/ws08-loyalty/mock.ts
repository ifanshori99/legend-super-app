// Mock handlers for the loyalty back office (`VITE_API_MOCK=true`), so every
// screen works with no API (docs/frontend.md "Typed endpoints and mock mode").
// They serve the CRM contract fixtures (bead legend-zk25) and keep edits in an
// in-memory store, so a save is visible on the list right away and a reload
// starts from the fixtures again.
//
// Loaded in Node by tests/legend-m8ow.test.mjs, so every import here is a bare
// package import or a relative `.ts` path (no `@/` alias). `?mock=empty` makes
// the lists report no tiers, rewards or missions while the program itself
// still exists (a tenant always has one).
import {
  cafeLegendCrmFixtures,
  createLoyaltyTier,
  createMission,
  createReward,
  getLoyaltyProgram,
  listLoyaltyTiers,
  listMissions,
  listRewards,
  updateLoyaltyProgram,
  updateLoyaltyTier,
  updateMission,
  updateReward,
  type LoyaltyProgram,
  type LoyaltyTier,
  type Mission,
  type Reward,
} from "@starter/shared/crm";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock, type MockContext } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

type LoyaltyMockState = {
  program: LoyaltyProgram;
  tiers: LoyaltyTier[];
  rewards: Reward[];
  missions: Mission[];
};

const store = createMockStore<LoyaltyMockState>(() => ({
  program: cafeLegendCrmFixtures.program,
  tiers: [...cafeLegendCrmFixtures.tiers],
  rewards: [...cafeLegendCrmFixtures.rewards],
  missions: [...cafeLegendCrmFixtures.missions],
}));

function sortedTiers(): LoyaltyTier[] {
  return [...store.get().tiers].sort((a, b) => a.rank - b.rank);
}

function newId(): string {
  return newIdempotencyKey();
}

function findTier(id: string): LoyaltyTier {
  const tier = store.get().tiers.find((candidate) => candidate.id === id);
  if (!tier)
    throw new ApiError(404, "NOT_FOUND", "Tier loyalty tidak ditemukan.");
  return tier;
}

function findReward(id: string): Reward {
  const reward = store.get().rewards.find((candidate) => candidate.id === id);
  if (!reward) throw new ApiError(404, "NOT_FOUND", "Reward tidak ditemukan.");
  return reward;
}

function findMission(id: string): Mission {
  const mission = store.get().missions.find((candidate) => candidate.id === id);
  if (!mission) throw new ApiError(404, "NOT_FOUND", "Misi tidak ditemukan.");
  return mission;
}

/** Drop undefined keys so a PATCH only changes what the client sent. */
function definedOnly<T extends object>(body: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

// ---- Program --------------------------------------------------------------

registerMock(getLoyaltyProgram, ({ scenario }) => ({
  data: {
    program: store.get().program,
    tiers: scenario === "empty" ? [] : sortedTiers(),
  },
}));

registerMock(updateLoyaltyProgram, ({ body }) => {
  const state = store.get();
  const program: LoyaltyProgram = {
    ...state.program,
    ...definedOnly(body),
    updatedAt: new Date().toISOString(),
  };
  store.set({ ...state, program });
  return { data: program };
});

// ---- Tiers ----------------------------------------------------------------

registerMock(listLoyaltyTiers, ({ scenario }) => ({
  data: scenario === "empty" ? [] : sortedTiers(),
}));

registerMock(createLoyaltyTier, ({ body }) => {
  const state = store.get();
  const tier: LoyaltyTier = {
    ...body,
    id: newId(),
    tenantId: state.program.tenantId,
  };
  store.set({ ...state, tiers: [...state.tiers, tier] });
  return { data: tier };
});

registerMock(updateLoyaltyTier, ({ params, body }) => {
  const state = store.get();
  const current = findTier(params.tierId);
  const tier: LoyaltyTier = { ...current, ...definedOnly(body) };
  store.set({
    ...state,
    tiers: state.tiers.map((candidate) =>
      candidate.id === tier.id ? tier : candidate,
    ),
  });
  return { data: tier };
});

// ---- Rewards --------------------------------------------------------------

registerMock(
  listRewards,
  ({ query, scenario }: MockContext<typeof listRewards>) => {
    const rewards = store.get().rewards.filter((reward) => {
      if (query.active === undefined) return true;
      return reward.isActive === (query.active === "true");
    });
    return paginateFixture(rewards, query, (reward) => reward.id, scenario);
  },
);

registerMock(createReward, ({ body }) => {
  const state = store.get();
  const reward: Reward = {
    ...body,
    id: newId(),
    tenantId: state.program.tenantId,
  };
  store.set({ ...state, rewards: [...state.rewards, reward] });
  return { data: reward };
});

registerMock(updateReward, ({ params, body }) => {
  const state = store.get();
  const current = findReward(params.rewardId);
  const reward: Reward = { ...current, ...definedOnly(body) };
  store.set({
    ...state,
    rewards: state.rewards.map((candidate) =>
      candidate.id === reward.id ? reward : candidate,
    ),
  });
  return { data: reward };
});

// ---- Missions -------------------------------------------------------------

registerMock(
  listMissions,
  ({ query, scenario }: MockContext<typeof listMissions>) => {
    const missions = store.get().missions.filter((mission) => {
      if (query.active === undefined) return true;
      return mission.isActive === (query.active === "true");
    });
    return paginateFixture(missions, query, (mission) => mission.id, scenario);
  },
);

registerMock(createMission, ({ body }) => {
  const state = store.get();
  const mission: Mission = {
    ...body,
    id: newId(),
    tenantId: state.program.tenantId,
  };
  store.set({ ...state, missions: [...state.missions, mission] });
  return { data: mission };
});

registerMock(updateMission, ({ params, body }) => {
  const state = store.get();
  const current = findMission(params.missionId);
  const mission: Mission = { ...current, ...definedOnly(body) };
  store.set({
    ...state,
    missions: state.missions.map((candidate) =>
      candidate.id === mission.id ? mission : candidate,
    ),
  });
  return { data: mission };
});
