# Preventivo — primeira versão

Operação separada da cobrança: orienta o aluno a pagar a mensalidade no
WebAluno antes de ela virar dívida. Importação de carteira, consulta ao Prime,
exportação de públicos para a mensageria e painel de resultados.

**Nada foi aplicado em produção.** As três migrations e a Edge Function estão
escritas e testadas, não implantadas. Procedimento de reversão em
`supabase/rollbacks/20260928143743_preventivo_estrutura.rollback.sql`.

## O achado que define o desenho

Conferido **ao vivo em 28/09/2026** (`GET /students/{registration}`, pela Edge
Function já existente `prime-acordo`, só leitura):

- o `financialStatement` tem **13 campos e nenhum é situação, status ou saldo
  em aberto**;
- `paymentDate` vem preenchido em **100% das linhas de todo portador** — 0 de
  302.477 linhas do portador 95 com data nula, **inclusive os 19.795 títulos que
  ainda vão vencer**, e nesses a data vem antes do vencimento em 19.705 de
  19.705 casos;
- `paidAmount` é **valor de tabela**: o dobro exato do principal em título
  vencido, e maior que o principal em 3.852 dos 19.705 a vencer.

Por isso o sistema **não registra pagamento**. Registra movimento de saldo
observado entre duas consultas, em tipos separados, e o painel diz na tela que
"valor recebido" **não está disponível pela fonte**, em vez de preencher esse
número com a redução de saldo — que mistura pagamento, cancelamento, bolsa e
renegociação. O campo `prev_evento.e_pagamento_comprovado` existe, começa
sempre falso e só muda quando houver fonte com data e valor.

O que falta pedir ao responsável pelo Prime está em
`docs/preventivo/README.md`, seção 4.

**O universo existe e é legível:** portador 95 ("SANTANDER CC 13050976-6 -
CONVENIO 272036"), a mensalidade corrente da ULBRA — 19.795 títulos a vencer e
7.182 com 1 a 31 dias de atraso, medidos em 28/09.

## Separação da cobrança

- tudo no prefixo `prev_`; **zero chave estrangeira** para tabela da cobrança e
  **zero escrita** fora do prefixo (os dois são verificados por teste);
- a identidade é **por título** (`carteira`, `matrícula Prime`, `documento`) —
  o mesmo aluno pode estar nas duas operações, e um pagamento observado num
  título nunca atualiza os outros;
- não cria caso, não cobra honorário, não mexe em responsável, distribuição,
  fidelização, acordo, fila, meta ou resultado; não entra nas Ações Massivas;
  não transfere título para a cobrança ao sair da janela.

## Acesso

`public.preventivo_e_gestao()` — só `amanda.seibel@aelbra.com.br`, ativa. Vale
na RLS (`force row level security`) de toda tabela `prev_*` e no começo de toda
RPC. Amanda ADM (`cobranca07@aelbra.com.br`) não passa, nem pela tela nem pela
API. Teste cobre os dois caminhos.

## Regras que estão em teste, não só em comentário

- 31 dias de atraso em **America/Sao_Paulo**: no 31 ainda é preventivo, no 32 não;
- reimportar o mesmo arquivo não duplica título nem valor, e **não reescreve o
  valor de entrada** da carteira;
- a prévia não grava nada e roda a mesma validação da confirmação;
- reconsultar o Prime sem mudança não duplica movimento (`prev_evento.chave`);
- sumir do extrato **não** é recebimento, e não apaga o saldo conhecido;
- falha de consulta preserva o dado anterior e o ciclo termina como FALHOU —
  nunca vira "atualizado";
- payload fora da forma esperada é erro, nunca "extrato vazio";
- WhatsApp: `55`+DDD+celular só dígitos; fixo e número incompleto ficam de fora
  com motivo, e **nada é completado em silêncio**; número compartilhado por
  alunos diferentes não entra para nenhum dos dois; um aluno por público;
- exportar não é enviar: `Preparada → Exportada → Envio confirmado` é ordem
  obrigatória, e **nada nesta frente dispara mensagem**;
- o painel reconcilia: entrada − redução + aumento = saldo atual.

## Evidências

- `supabase/tests/preventivo_comportamento.test.js` — 42 testes de
  comportamento, rodando as migrations reais em PostgreSQL de verdade (PGlite);
- `src/utils/preventivo.test.js` — 24 testes, incluindo a comparação caso a
  caso entre a normalização de celular da tela e a do banco;
- preview visual das quatro abas sem login:
  `npx vite --config vite.preview-preventivo.config.js`.

## Documentação

`docs/integracoes/` atualizado no mesmo commit, como manda o `CLAUDE.md`:
`prime-api.md`, `prime-api-catalog.json`, `prime-mapa-fontes-verdade.md`,
`prime-mapa-identificadores.md`, `prime-gaps.md` e `prime-edge-functions.md`.
Passo a passo de operação em `docs/preventivo/README.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
