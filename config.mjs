export const COLORS = [
  ['lime','Lime','#c2f653','#203000'],['violet','Violet','#b9a1ff','#27164f'],
  ['coral','Coral','#ff837c','#4e1717'],['sky','Sky','#70c5ff','#102d48'],
  ['yellow','Yellow','#ffe16d','#403500'],['pink','Pink','#f892cf','#4f133d'],
  ['mint','Mint','#7bdeb4','#133c2c'],['orange','Orange','#ffad4a','#472500'],
  ['lilac','Lilac','#dcc6ff','#3d2858'],['teal','Teal','#2bb9a8','#062e29'],
  ['red','Red','#dd4556','#fff'],['blue','Blue','#476beb','#fff'],
  ['purple','Purple','#814ace','#fff'],['forest','Forest','#397c4f','#fff'],
  ['rust','Rust','#b85c36','#fff'],['gold','Gold','#b29a32','#171402'],
  ['rose','Rose','#ba5080','#fff'],['slate','Slate','#7797aa','#12202b'],
  ['cream','Cream','#f1e4c4','#443b26'],['silver','Silver','#b8bfcc','#28303d']
].map(([id,name,hex,ink])=>({id,name,hex,ink}));
export const THEMES = [
  {id:'standard',title:'Standard',short:'Standard',colors:['#c2f653','#b9a1ff']},
  {id:'halloween',title:'Halloween',short:'Halloween',colors:['#ffad4a','#904fcc']},
  {id:'thanksgiving',title:'Thanksgiving',short:'Autumn',colors:['#efbd64','#b85c36']},
  {id:'winter',title:'Christmas / Winter',short:'Winter',colors:['#397c4f','#ff7d86']},
  {id:'spring',title:'Easter / Spring',short:'Spring',colors:['#b8dfc6','#d7c9f1']}
];
