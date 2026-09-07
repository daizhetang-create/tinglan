export async function abortable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();
  let onAbort:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{onAbort=()=>reject(new DOMException('已取消，已保存的录音保留','AbortError'));signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([pending,cancelled]);}finally{signal.removeEventListener('abort',onAbort);}
}
