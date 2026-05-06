/** screenshot-desktop — optional runtime dep for real screen capture (desktop only). */
declare module "screenshot-desktop" {
  function screenshot(options?: { format?: string; screen?: number }): Promise<Buffer>;
  namespace screenshot {}
  export default screenshot;
}

/** @nut-tree-fork/nut-js — optional runtime dep for real desktop input (desktop only). */
declare module "@nut-tree-fork/nut-js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const mouse: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const keyboard: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const screen: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Button: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Key: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function straightTo(target: any): any;
}
