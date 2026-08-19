// Config exclusiva do preview visual. Troca a camada de serviço por dados de
// exemplo, para conseguir ver a Central sem login, sem banco e sem WhatsApp
// pareado. O COMPONENTE é o real — o que aparece na tela é o código do PR.
//
// O alias de `./supabase` também é proposital: sem ele, o módulo real do
// Supabase roda na carga e apaga a página inteira reclamando de variável de
// ambiente ausente. Aqui não existe banco nenhum para configurar.
import { resolve } from "node:path";

export default {
  server: { port: 5199, strictPort: true },
  resolve: {
    alias: [
      { find: /^.*\/services\/whatsapp$/, replacement: resolve("./.preview/mock-whatsapp.js") },
      { find: /^.*\/services\/supabase$/, replacement: resolve("./.preview/mock-supabase.js") },
      { find: /^\.{1,2}\/supabase$/,      replacement: resolve("./.preview/mock-supabase.js") },
    ],
  },
};
