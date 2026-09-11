/** Serializes whole inference sessions, including follow-up crops. Rejections release the queue. */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
