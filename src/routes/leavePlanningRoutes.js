const express=require('express');
const rateLimit=require('express-rate-limit');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const EXPECTED_SENDER='13362186470';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function createLeavePlanningRouter({whatsappClient,env=process.env}){
 const router=express.Router();
 const dir=env.LEAVE_PLANNING_STORAGE_PATH||'/var/data/leave-planning';
 const groupFile=path.join(dir,'group.json');
 function auth(req,res,next){
  const expected=env.LEAVE_PLANNING_SECRET||'',actual=String(req.get('authorization')||'').replace(/^Bearer /,'');
  if(!expected||!actual||!crypto.timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(actual))))return res.status(401).json({error:'Unauthorized.'});
  next();
 }
 function identity(){const i=whatsappClient.getSenderIdentity();return {sender:i.phone||null,expectedSender:EXPECTED_SENDER,status:i.status,ready:i.status==='ready'&&i.phone===EXPECTED_SENDER};}
 function selected(){try{return JSON.parse(fs.readFileSync(groupFile,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 function save(file,value,flags='w'){fs.mkdirSync(dir,{recursive:true,mode:0o700});const fd=fs.openSync(file,flags,0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 const limit=rateLimit({windowMs:60*1000,limit:30,standardHeaders:true,legacyHeaders:false});
 router.use('/leave-planning',auth,limit);
 router.get('/leave-planning/status',async(_req,res)=>{
  const state=identity();res.set('Cache-Control','no-store');
  try{return res.json({...state,group:selected(),groups:state.ready?await whatsappClient.listGroups():[]});}
  catch{return res.status(503).json({...state,error:'WhatsApp groups could not be checked.'});}
 });
 router.post('/leave-planning/pairing',async(_req,res)=>{
  try{
   if(['starting','disconnected'].includes(whatsappClient.getStatus()))await whatsappClient.initializeWhatsApp();
   return res.set('Cache-Control','no-store').json({...identity(),qrDataUrl:whatsappClient.getQrDataUrl()||null});
  }catch{return res.status(503).json({error:'WhatsApp is reconnecting. Try again shortly.'});}
 });
 router.post('/leave-planning/group',async(req,res)=>{
  if(!identity().ready)return res.status(409).json({state:'NOT_ATTEMPTED',error:'Reconnect Meridian business WhatsApp.'});
  try{
   const group=(await whatsappClient.listGroups()).find(g=>g.id===req.body?.groupId);
   if(!group)return res.status(422).json({error:'Choose a current WhatsApp group.'});
   save(groupFile+'.tmp',group);fs.renameSync(groupFile+'.tmp',groupFile);
   return res.json({group});
  }catch{return res.status(503).json({error:'The group could not be saved.'});}
 });
 router.post('/leave-planning/send-contact',async(req,res)=>{
  const key=String(req.get('x-idempotency-key')||''),{contact,message,imageBase64,imageFilename}=req.body||{};
  const blocked=error=>res.status(409).json({success:false,state:'NOT_ATTEMPTED',error});
  if(!/^brief:[a-zA-Z0-9_:.-]{1,180}$/.test(key)||typeof contact!=='string'||!contact.trim()||typeof message!=='string'||!message.trim()||message.length>10000)return blocked('Invalid internal brief notification.');
  if(imageBase64!=null&&typeof imageBase64!=='string')return blocked('Invalid brief image.');
  const file=path.join(dir,hash(key)+'.json'),fingerprint=hash(JSON.stringify({contact,message,imageBase64:imageBase64||'',imageFilename:imageFilename||''}));
  const unknown={statusCode:502,body:{success:false,state:'SEND_ATTEMPTED_UNCONFIRMED'}};
  try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.fingerprint!==fingerprint)return blocked('Notification key conflict.');return res.status(old.statusCode).json({...old.body,cached:true});}
  catch(e){if(e.code!=='ENOENT')return res.status(502).json(unknown.body);}
  if(!identity().ready)return blocked('Reconnect Meridian business WhatsApp.');
  try{
   save(file,{fingerprint,...unknown},'wx');
   const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }catch(e){if(e.code==='EEXIST')return res.status(502).json(unknown.body);return blocked('Brief notification storage is unavailable.');}
  let outcome=unknown;
  try{
   let sendTarget=contact.trim();
   try{
    const prior=whatsappClient.listInboundMessages({contact:sendTarget,limit:500})||[];
    const verified=prior.find(row=>row&&row.lid&&row.resolvedPhone);
    if(verified&&verified.lid)sendTarget=verified.lid;
   }catch{}
   const sent=await whatsappClient.sendContactMessage({contact:sendTarget,message,imageBase64:imageBase64||'',imageFilename:imageFilename||'meridian-daily-brief.jpg'});
   if(sent.messageId)outcome={statusCode:200,body:{success:true,messageId:sent.messageId,sentAt:sent.sentAt}};
  }catch{/* Any exception after dispatch may have sent. Never auto-repeat as a new message. */}
  try{save(file+'.tmp',{fingerprint,...outcome});fs.renameSync(file+'.tmp',file);}catch{}
  return res.status(outcome.statusCode).json(outcome.body);
 });

 router.post('/leave-planning/send',async(req,res)=>{
  const key=String(req.get('x-idempotency-key')||''),{groupId,message}=req.body||{};
  const blocked=error=>res.status(409).json({success:false,state:'NOT_ATTEMPTED',error});
  if(!/^leave:[a-zA-Z0-9_:.-]{1,180}$/.test(key)||typeof message!=='string'||!message.trim()||message.length>10000)return blocked('Invalid leave notification.');
  const file=path.join(dir,hash(key)+'.json'),fingerprint=hash(JSON.stringify({groupId,message}));
  const unknown={statusCode:502,body:{success:false,state:'SEND_ATTEMPTED_UNCONFIRMED'}};
  // Existing durable receipts take precedence even if the connection/group later changes.
  try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.fingerprint!==fingerprint)return blocked('Notification key conflict.');return res.status(old.statusCode).json({...old.body,cached:true});}
  catch(e){if(e.code!=='ENOENT')return res.status(502).json(unknown.body);}
  if(!identity().ready)return blocked('Reconnect Meridian business WhatsApp.');
  try{
   const group=selected();
   if(!group||group.id!==groupId)return blocked('Leave Planning group is not configured.');
   if(!(await whatsappClient.listGroups()).some(g=>g.id===groupId))return blocked('Meridian is no longer in the selected group.');
   save(file,{fingerprint,...unknown},'wx');
   const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }catch(e){if(e.code==='EEXIST')return res.status(502).json(unknown.body);return blocked('Leave notification storage or group is unavailable.');}
  let outcome=unknown;
  try{const sent=await whatsappClient.sendContactMessage({contact:groupId,message});if(sent.messageId)outcome={statusCode:200,body:{success:true,messageId:sent.messageId,sentAt:sent.sentAt}};}
  catch{/* Any exception after dispatch may have sent. Never retry as a new message. */}
  try{save(file+'.tmp',{fingerprint,...outcome});fs.renameSync(file+'.tmp',file);}catch{}
  return res.status(outcome.statusCode).json(outcome.body);
 });
 return router;
}
module.exports={createLeavePlanningRouter};
