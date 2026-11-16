export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const fail = (status: number, code: string): never => {
  throw new ApiError(status, code);
};
