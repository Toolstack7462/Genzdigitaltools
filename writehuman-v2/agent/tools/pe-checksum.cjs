'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
function inspect(bytes){
  assert.ok(bytes.length>=64&&bytes.toString('ascii',0,2)==='MZ','Invalid DOS header');
  const pe=bytes.readUInt32LE(60);
  assert.ok(pe>=64&&pe+24<=bytes.length&&bytes.toString('binary',pe,pe+4)==='PE\0\0','Invalid PE header');
  const optional=pe+24,size=bytes.readUInt16LE(pe+20);
  assert.ok(size>=68&&optional+size<=bytes.length,'Truncated optional header');
  assert.ok([0x10b,0x20b].includes(bytes.readUInt16LE(optional)),'Unsupported optional header');
  const offset=optional+64;let sum=0;
  for(let i=0;i<bytes.length;i+=2){
    if(i===offset||i===offset+2)continue;
    sum+=bytes[i]+((bytes[i+1]||0)<<8);sum=(sum&0xffff)+(sum>>>16);
  }
  sum=(sum&0xffff)+(sum>>>16);
  const computed=(sum+bytes.length)>>>0,stored=bytes.readUInt32LE(offset);
  return {offset,stored,computed,matches:stored===computed};
}
module.exports={inspect};
if(require.main===module){
  const [file,mode]=process.argv.slice(2);assert.ok(file,'Usage: node tools/pe-checksum.cjs EXE [--write]');
  const bytes=fs.readFileSync(file),before=inspect(bytes);
  if(mode==='--write'){bytes.writeUInt32LE(before.computed,before.offset);fs.writeFileSync(file,bytes);}
  const result=inspect(fs.readFileSync(file));console.log(JSON.stringify(result));
  if(!result.matches)process.exitCode=1;
}
