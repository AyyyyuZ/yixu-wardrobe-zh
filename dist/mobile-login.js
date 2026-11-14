const form=document.querySelector('#login-form'),message=document.querySelector('#message');
form.addEventListener('submit',async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true;message.textContent='正在打开衣橱…';
  try{
    const response=await fetch('/mobile-api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:new FormData(form).get('password')})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'登录失败');location.href='/manage';
  }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
});
