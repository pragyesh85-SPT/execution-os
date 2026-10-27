/** A refusal with a message a person (or Claude) can act on; `status` is the HTTP status the hub sends. */
export class StudyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'StudyError';
  }
}
