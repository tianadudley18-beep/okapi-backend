export const PLAN_LIMITS = {
  free: {
    name: 'Free',
    aiMessagesPerMonth: 10,
    filesPerMonth: 3,
    projectsMax: 1,
    price: 0,
  },
  monthly: {
    name: 'Mensual',
    aiMessagesPerMonth: 150,
    filesPerMonth: 999,
    projectsMax: 5,
    price: 7.45,
  },
  annual: {
    name: 'Anual',
    aiMessagesPerMonth: 999999,
    filesPerMonth: 999,
    projectsMax: 20,
    price: 34.99,
  },
}
