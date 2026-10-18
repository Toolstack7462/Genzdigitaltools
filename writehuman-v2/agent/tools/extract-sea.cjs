'use strict';
// Static extraction only: this utility never executes the supplied PE image.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function extract(bytes){
  if(bytes.length<128||bytes.toString('ascii',0,2)!=='MZ')throw new Error('Not a PE image');
  const pe=bytes.readUInt32LE(60);
  if(pe+24>bytes.length||bytes.toString('ascii',pe,pe+4)!=='PE\0\0')throw new Error('Invalid PE header');
  const marker=Buffer.from('wh-agent-sea.js');
  let at=0,found=null;
  while((at=bytes.indexOf(marker,at))>=0){
    try{
      // Node serializes config.main verbatim: native builders may use an absolute
      // path. Find its bounded length prefix without ever writing that path out.
      let nameStart=-1;
      for(let candidate=at-8;candidate>=Math.max(0,at-4096);candidate--){
        const length=at+marker.length-(candidate+8);
        if(bytes.readBigUInt64LE(candidate)===BigInt(length)){
          const name=bytes.toString('utf8',candidate+8,at+marker.length);
          if(!name.includes('\0')&&(name===marker.toString()||/[\\/]wh-agent-sea\.js$/.test(name))){nameStart=candidate;break;}
        }
      }
      if(nameStart<0){at++;continue;}
      let offset=at+marker.length;
      const readCount=(max)=>{if(offset+8>bytes.length)throw new Error('Truncated size');const value=bytes.readBigUInt64LE(offset);offset+=8;if(value>BigInt(max))throw new Error('Invalid size');return Number(value);};
      const readString=()=>{const size=readCount(10*1024*1024);if(offset+size>bytes.length)throw new Error('Truncated entry');const value=bytes.subarray(offset,offset+size);offset+=size;return value;};
      const main=readString();
      if(main.length<500||!main.toString('utf8',0,100).includes("'use strict'")){at++;continue;}
      const files={'wh-agent-sea.js':main};
      const count=readCount(20);
      for(let n=0;n<count;n++){
        const name=readString().toString('utf8');
        if(!/^[a-zA-Z0-9_.-]+$/.test(name)||name==='.'||name==='..'||Object.hasOwn(files,name))throw new Error('Invalid asset name');
        files[name]=readString();
      }
      if(!files['cookie-sync-agent.js'])throw new Error('Agent source asset missing');
      if(found)throw new Error('Ambiguous source payloads');
      found={files,offset:at};
    }catch(e){if(e.message==='Ambiguous source payloads')throw e;}
    at++;
  }
  if(!found)throw new Error('No complete supported SEA source payload');
  return {...found,manifest:{executableSha256:hash(bytes),sizeBytes:bytes.length,
    files:Object.fromEntries(Object.entries(found.files).map(([name,b])=>[name,{sizeBytes:b.length,sha256:hash(b)}]))}};
}
if(require.main===module){
  try{
    const [input,dest]=process.argv.slice(2);if(!input||!dest)throw new Error('Usage: node tools/extract-sea.cjs INPUT.exe OUTPUT_DIRECTORY');
    const result=extract(fs.readFileSync(input));fs.mkdirSync(dest,{recursive:true});
    for(const [name,b]of Object.entries(result.files))fs.writeFileSync(path.join(dest,name),b);
    fs.writeFileSync(path.join(dest,'extraction-manifest.json'),JSON.stringify(result.manifest,null,2)+'\n');
    console.log(JSON.stringify(result.manifest,null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={extract};
