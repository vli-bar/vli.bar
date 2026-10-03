const DATABASE = 'vli-live-lab';
function openDatabase() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DATABASE,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('takes');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export async function saveTake(clip) {
  const db=await openDatabase();
  try {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('takes','readwrite');
      tx.objectStore('takes').put(clip,'latest');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  } finally {db.close();}
}
export async function restoreTake() {
  const db=await openDatabase();
  try {return await new Promise((resolve,reject)=>{
    const request=db.transaction('takes').objectStore('takes').get('latest');
    request.onsuccess=()=>resolve(request.result || null);request.onerror=()=>reject(request.error);
  });} finally {db.close();}
}
