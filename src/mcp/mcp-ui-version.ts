/** Return a historical MCP Apps URI from the current versioned resource URL.
 * Preserve old ChatGPT resource identifiers without shadowing the current URI.
 * No OAuth identity or credentials are involved.
 */
export function compatibilityResourceUri(currentUri:string,version:number):string {
  if(!Number.isInteger(version)||version<1||version>100)
    throw new Error('NYX_MCP_UI_ALIAS_VERSION_INVALID');
  const oldUri=currentUri.replace(/\/v\d+\.html$/, '/v'+version+'.html');
  if(oldUri===currentUri)throw new Error('NYX_MCP_UI_ALIAS_URI_INVALID');
  return oldUri;
}
