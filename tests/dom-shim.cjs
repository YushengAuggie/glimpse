// Minimal DOM for testing DOM-building helpers without a dependency.
// Supports: createElement, createTextNode, createDocumentFragment, appendChild,
// textContent, setAttribute/getAttribute, tagName, and innerHTML serialization.
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
class Node { constructor(){ this.childNodes=[]; } appendChild(c){ this.childNodes.push(c); return c; }
  get textContent(){ return this.childNodes.map(c=>c.textContent).join(""); }
  set textContent(v){ this.childNodes=[new Text(v)]; } }
class Text extends Node { constructor(t){ super(); this._t=String(t); } get textContent(){ return this._t; }
  get _html(){ return esc(this._t); } }
class Frag extends Node { get _html(){ return this.childNodes.map(c=>c._html).join(""); } }
class El extends Node { constructor(tag){ super(); this.tagName=tag.toUpperCase(); this.attrs={}; }
  setAttribute(k,v){ this.attrs[k]=String(v); } getAttribute(k){ return this.attrs[k]; }
  set textContent(v){ this.childNodes=[new Text(v)]; } get textContent(){ return super.textContent; }
  get innerHTML(){ return this.childNodes.map(c=>c._html).join(""); }
  get _html(){ const a=Object.keys(this.attrs).map(k=>` ${k}="${esc(this.attrs[k])}"`).join("");
    return `<${this.tagName.toLowerCase()}${a}>${this.innerHTML}</${this.tagName.toLowerCase()}>`; } }
const document = { createElement:t=>new El(t), createTextNode:t=>new Text(t), createDocumentFragment:()=>new Frag(),
  getElementById:()=>null, readyState:"complete", addEventListener:()=>{} };
module.exports = { document, window: { document } };
