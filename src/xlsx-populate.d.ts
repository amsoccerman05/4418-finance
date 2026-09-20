declare module "xlsx-populate/browser/xlsx-populate-no-encryption.min.js" {
  const library: { fromDataAsync(data: ArrayBuffer): Promise<any> };
  export default library;
}
