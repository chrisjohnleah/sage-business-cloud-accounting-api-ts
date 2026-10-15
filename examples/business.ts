import type { Sage } from 'sage-business-cloud-accounting-api'

/** Picks the first business this Sage login can reach. A real app would let the person choose. */
export async function chooseBusiness(sage: Sage) {
  const [business] = await sage.listBusinesses()
  if (!business?.id) throw new Error('This Sage login has no businesses.')
  await sage.selectBusiness(business.id)
}
