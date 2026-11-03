export class SapReconRuleViolation extends Error {
  constructor(readonly rule: string, message: string) {
    super(message)
    this.name = 'SapReconRuleViolation'
  }
}
