# Preview visual da Central WhatsApp

Serve para **olhar a tela** sem login, sem banco e sem WhatsApp pareado.

```bash
npx vite --config vite.preview.config.js
# abre http://localhost:5199/preview-central.html
```

A barra preta no topo alterna entre **Operador** e **Gestão**.

## O que é real e o que não é

O **componente é o real** (`src/pages/CentralWhatsApp.jsx`). O que está trocado
é só a camada de serviço: `vite.preview.config.js` aponta
`services/whatsapp` e `services/supabase` para os arquivos daqui.

Uma exceção: a **ficha do aluno**, que a Central abre em popup, entra como
dublê (`mock-ficha-aluno.jsx`). A ficha real fala com o banco em dezenas de
consultas; montá-la aqui mostraria uma tela de erro e pareceria defeito da
Central. O que o preview prova sobre ela é o enquadramento — abre por cima da
conversa, o topo com o Fechar não rola junto, a Central continua atrás.

Nenhum dado vem de produção. `dados.js` é inventado.

## Por que isto existe

A Central só aparece para quem está autenticado no CRM. Sem este harness, rever
a tela exige credencial de produção — ou seja, na prática ninguém revê. Aqui dá
para clicar em tudo, inclusive nos caminhos difíceis de reproduzir de propósito:
número fora do ar, conversa de outro operador, aluno ambíguo, canal aguardando QR.

## Cuidado ao mexer nos mocks

O mock precisa se comportar como a RPC, não como um atalho. Dois exemplos que já
enganaram durante uma revisão:

- **devolver o mesmo array mutado** faz os `useMemo` da tela nunca recalcularem,
  e um "defeito" aparece que não existe em produção (a RPC devolve objetos novos);
- **inverter a ordem das mensagens** — a camada real já entrega na ordem de
  leitura; inverter de novo aqui mostra a conversa de trás para frente.

Quando o preview mostrar algo estranho, desconfie primeiro daqui.
