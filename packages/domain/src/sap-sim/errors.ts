export class SapSimRuleViolation extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message)
    this.name = 'SapSimRuleViolation'
  }
}
