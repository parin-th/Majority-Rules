export const SUPPORTED_LANGUAGES = ['en','es','fr'];
export function chooseLanguage(query,stored,browserLanguages=[]){
  for(const value of [query,stored,...browserLanguages]){
    const code=typeof value==='string'?value.toLowerCase().split('-')[0]:'';
    if(SUPPORTED_LANGUAGES.includes(code))return code;
  }
  return 'en';
}
export function translate(catalog,language,key,values={}){
  const text=catalog[language]?.ui?.[key]??catalog.en.ui[key]??key;
  return text.replace(/\{(\w+)\}/g,(match,name)=>Object.hasOwn(values,name)?String(values[name]):match);
}
export function localizeQuestion(catalog,language,question){
  if(!question||question.custom||language==='en')return question;
  const localized=catalog[language]?.questions?.[question.prompt];
  if(!localized||localized.sourceA!==question.a||localized.sourceB!==question.b)return question;
  return {...question,prompt:localized.prompt,a:localized.a,b:localized.b};
}
export function localizeDeck(catalog,language,deck){
  return {...deck,...catalog[language]?.decks?.[deck.id]};
}
export function translateError(catalog,language,message){
  if(['Failed to fetch','fetch failed','Load failed','NetworkError when attempting to fetch resource.'].includes(message))return translate(catalog,language,'connectionError');
  return catalog[language]?.errors?.[message]??message??translate(catalog,language,'unknownError');
}
