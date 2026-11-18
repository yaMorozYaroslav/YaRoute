const {test}=require('node:test');
const assert=require('node:assert/strict');
require('reflect-metadata');
const {ConnectorsModule}=require('../dist/connectors/connectors.module');
const {McpModule}=require('../dist/mcp/mcp.module');
const {McpService}=require('../dist/mcp/mcp.service');
const {TenantRcloneUploadService}=require('../dist/connectors/tenant-rclone-upload.service');
const {RcloneUploadController}=require('../dist/connectors/rclone-upload.controller');

test('McpService tenant upload dependency is registered and exported from its imported module',()=>{
  const types=Reflect.getMetadata('design:paramtypes',McpService);
  assert.equal(types[11],TenantRcloneUploadService);
  const providers=Reflect.getMetadata('providers',ConnectorsModule)||[];
  const exports=Reflect.getMetadata('exports',ConnectorsModule)||[];
  const imports=Reflect.getMetadata('imports',McpModule)||[];
  const controllers=Reflect.getMetadata('controllers',ConnectorsModule)||[];
  assert.ok(imports.includes(ConnectorsModule),'McpModule imports ConnectorsModule');
  assert.ok(providers.includes(TenantRcloneUploadService),'upload service provided');
  assert.ok(exports.includes(TenantRcloneUploadService),'upload service exported');
  assert.ok(controllers.includes(RcloneUploadController),'upload controller provided');
});
