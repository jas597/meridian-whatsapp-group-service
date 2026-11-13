const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/whatsappClient.js'),'utf8');
const start=source.indexOf('async function sendContactMessage(');
const end=source.indexOf('\nmodule.exports =',start);
const body=source.slice(start,end);
function client({reject=false}={}){
 const calls=[];
 const context={requireReadyClient:()=>({sendMessage:async(...args)=>{calls.push(args);if(reject)throw Error('uncertain send');return{id:{_serialized:'sent-id'}};}}),buildImageMedia:()=>({mimetype:'image/png'}),normalizeContactTarget:x=>x,watchOutgoingMessageCreate:()=>({cancel(){},promise:Promise.resolve()}),messageSerializedId:m=>m?.id?._serialized,logger:{info(){},error(){},warn(){}},process:{env:{}},Date};
 vm.createContext(context);vm.runInContext(body+'\nthis.send=sendContactMessage;',context);
 return{send:context.send,calls};
}
test('Sales group receives one inline image',async()=>{const c=client();await c.send({contact:'123@g.us',message:'Sales report',imageBase64:'sample',imageFilename:'report.png'});assert.equal(c.calls.length,1);assert.equal(c.calls[0][2].sendMediaAsDocument,false);});
test('Individual chat retains the document upload path',async()=>{const c=client();await c.send({contact:'123@c.us',message:'Daily brief',imageBase64:'sample',imageFilename:'brief.png'});assert.equal(c.calls.length,1);assert.equal(c.calls[0][2].sendMediaAsDocument,true);});
test('A failed media send is never retried in another format',async()=>{const c=client({reject:true});await assert.rejects(c.send({contact:'123@g.us',message:'Sales report',imageBase64:'sample'}));assert.equal(c.calls.length,1);});

