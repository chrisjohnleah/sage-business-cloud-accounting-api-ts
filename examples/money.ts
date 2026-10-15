import { toPence } from 'sage-business-cloud-accounting-api'

toPence('120.00') // 12000
toPence(120) // 12000
toPence('0.5') // 50
toPence('-3.20') // -320
