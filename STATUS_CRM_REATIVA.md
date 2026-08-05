# STATUS CRM ReATIVA

## 2026-08-05 — Correção: botão "Abrir" da notificação de link ia para a fila Base

### Correção realizada
O botão **Abrir** do popup de notificações do operador (link recebido /
`LINK_PRONTO_PARA_ENVIO`, termo aprovado, retorno financeiro) agora abre
diretamente a **ficha única do aluno** pelo `aluno_id` da notificação, no padrão
existente do CRM (`reativa_aluno_abrir_id` → `/aluno`). A aba inicial já renderiza
o bloco de Links, onde o operador vê o link em `LINK_PRONTO_PARA_ENVIO` e conclui
por **"Marcar enviado ao aluno"** pelo fluxo atual (status → `LINK_ENVIADO_AO_ALUNO`).

### Causa do erro
`NotificacoesPopup.abrir()` fazia duas coisas erradas:
1. Gravava o aluno na chave `alunoSelecionado`, mas a tela `/aluno` lê a ficha
   pela chave `reativa_aluno_abrir_id` (via `abrirAlunoPorId`). A chave nunca era lida.
2. Navegava para `n.url_destino || "/painel-carteira"`. Para links/baixa o
   `url_destino` aponta para `/fila-operacional` / `/painel-carteira` (a **fila Base**),
   então o operador caía na fila e a ficha nunca abria.

Correção: com `aluno_id` válido, grava `reativa_aluno_abrir_id` e navega para
`/aluno?origem=notificacao` (abre pelo id, nunca por CPF/aproximação). Sem
`aluno_id`, mantém `url_destino` quando existir; se não houver vínculo nem destino,
exibe mensagem clara e não abre outro aluno.

### Arquivos alterados
- `src/components/NotificacoesPopup.jsx` — função `abrir(n)` (alteração mínima).

### Testes executados
- `npm run build` — sucesso (built in ~1s, sem erros).
- App carrega no preview (localhost:5173) sem erros de console.
- Verificação estática: `Aluno.jsx:467` lê `reativa_aluno_abrir_id` e chama
  `abrirAlunoPorId`; a ficha renderiza `LinksPagamentoAluno` na aba inicial
  (`Aluno.jsx:2099`, bloco `abaFicha === "dados"`).

### Regras preservadas
Sem alteração de responsável/carteira/fidelização/distribuição/prioridade; abertura
exclusivamente por `aluno_id`; nenhuma nova rota/página/aba; conclusão do envio só
por "Marcar enviado ao aluno"; demais fluxos (termos, financeiro, baixa, confirmação)
inalterados.

### Resultado da publicação
- Branch `fix/notificacao-abre-ficha-por-aluno-id` → merge em `main` (86cf07c),
  correção em b2b74b2. `git push origin main` OK (a7a1d0e..86cf07c) → Vercel builda main.
- Este push também subiu o commit pendente da sessão anterior (a7a1d0e — Penetração por Ano).
