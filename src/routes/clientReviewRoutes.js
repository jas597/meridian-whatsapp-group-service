const express=require('express');
const rateLimit=require('express-rate-limit');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {requireBearerSecret}=require('../middleware/auth');

function createClientReviewRouter({whatsappClient,env=process.env}){
 const router=express.Router(),limit=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:true,legacyHeaders:false});
 const status=()=>{const identity=whatsappClient.getSenderIdentity();return {groupName:(env.ALLOWED_GROUP_NAME||'Meridian Staff').trim(),sender:identity.phone||null,ready:identity.status==='ready'&&!!identity.expected&&identity.matches===true};};
 router.get('/client-group-status',requireBearerSecret,(_req,res)=>res.set('Cache-Control','no-store').json(status()));
 router.post('/send-client-review-group',requireBearerSecret,limit,async(req,res)=>{
  const {group,message}=req.body||{},key=req.get('x-idempotency-key')||'',s=status();
  const blocked=errorCode=>res.status(409).json({success:false,state:'NOT_ATTEMPTED',errorCode});
  if(typeof group!=='string'||group!==s.groupName)return blocked('WHATSAPP_GROUP_MISMATCH');
  if(typeof message!=='string'||!message.trim()||message.length>10000||!/^client-review-[a-zA-Z0-9_.:-]{1,160}$/.test(key))return blocked('INVALID_NOTIFICATION');
  if(!s.ready)return blocked('WHATSAPP_RECONNECT');
  let selected;
  try{const matches=(await whatsappClient.listGroups()).filter(g=>g.name===group);if(matches.length!==1)return blocked(matches.length?'WHATSAPP_GROUP_AMBIGUOUS':'WHATSAPP_GROUP_NOT_FOUND');selected=matches[0];if(env.ALLOWED_GROUP_ID&&env.ALLOWED_GROUP_ID!==selected.id)return blocked('WHATSAPP_GROUP_MISMATCH');}catch{return blocked('WHATSAPP_GROUP_UNAVAILABLE');}
  const dir=env.CLIENT_REVIEW_RECEIPTS_PATH||'/var/data/client-review-receipts',file=path.join(dir,crypto.createHash('sha256').update(key).digest('hex')+'.json');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({groupId:selected.id,message})).digest('hex');
  const unknown={statusCode:502,body:{success:false,state:'SEND_ATTEMPTED_UNCONFIRMED',errorCode:'WHATSAPP_UNCONFIRMED'}};
  const save=(target,value,flags)=>{const fd=fs.openSync(target,flags,0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  try{fs.mkdirSync(dir,{recursive:true,mode:0o700});save(file,{fingerprint,...unknown},'wx');const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  catch(error){if(error.code!=='EEXIST')return blocked('NOTIFICATION_STORAGE_UNAVAILABLE');try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.fingerprint!==fingerprint)return blocked('NOTIFICATION_KEY_CONFLICT');return res.status(old.statusCode).json({...old.body,cached:true});}catch{return res.status(502).json(unknown.body);}}
  let outcome=unknown;
  try{const sent=await whatsappClient.sendGroupMessage({group,message,singleAttempt:true,resolvedGroupId:selected.id});if(sent.messageId)outcome={statusCode:200,body:{success:true,group,messageId:sent.messageId,sentAt:sent.sentAt}};}
  catch(error){if(error.state!=='SEND_ATTEMPTED_UNCONFIRMED')outcome={statusCode:409,body:{success:false,state:'NOT_ATTEMPTED',errorCode:'WHATSAPP_NOT_READY'}};}
  try{save(file+'.tmp',{fingerprint,...outcome},'w');fs.renameSync(file+'.tmp',file);}catch{}
  return res.status(outcome.statusCode).json(outcome.body);
 });
 return router;
}
module.exports={createClientReviewRouter};
