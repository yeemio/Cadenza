/** Deliberately small value allowlist. Every other value (including comments/multiline values) is omitted. */
const rules={NODE_ENV:/^(development|test|production)$/,LOG_LEVEL:/^(trace|debug|info|warn|error|fatal|silent)$/,PORT:/^\d{1,5}$/,API_PORT:/^\d{1,5}$/,WORKER_ENABLED:/^(true|false)$/}
export function redactedConfiguration(text){
  const lines=['# Non-secret allowlist only. Omitted values must be supplied from approved configuration/secret storage.']
  const seen=new Set()
  for(const line of text.split(/\r?\n/)){
    const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if(!match)continue
    const [,key,raw]=match;if(seen.has(key))continue;seen.add(key)
    const value=raw.trim().replace(/^(['"])(.*)\1$/,'$2')
    if(Object.hasOwn(rules,key)&&rules[key].test(value)&&(!key.endsWith('PORT')||(Number(value)>0&&Number(value)<=65535)))lines.push(`${key}=${value}`)
    else lines.push(`${key}=<REQUIRED_FROM_APPROVED_CONFIG_OR_SECRET_STORE>`)
  }
  return lines.join('\n')+'\n'
}
