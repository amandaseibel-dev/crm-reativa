# Preventivo — primeira versão

Operação separada da cobrança: orienta o aluno a pagar a mensalidade no
WebAluno antes de ela virar dívida. Importação da carteira, consulta ao Prime,
exportação de públicos para a mensageria e painel.

**Nada foi aplicado em produção.** Migrations e Edge Function estão escritas e
testadas, não implantadas. Reversão em
`supabase/rollbacks/20260928143743_preventivo_estrutura.rollback.sql`.

---

## ✅ Funcional e validado

- **Importação com o arquivo REAL** (`relatorio_inadimplencia 28.09.csv`,
  3.495 linhas), ponta a ponta: 3.480 títulos / 3.471 alunos /
  R$ 5.679.282,71; 15 recusadas (14 duplicadas no arquivo, 1 sem nome).
  **Reimportar o mesmo arquivo não duplicou nada.** O mapeamento das colunas foi
  reconhecido sozinho, incluindo `Código` → matrícula e `Dt Vcto` → vencimento.
- **Duas correções que só o arquivo real revelou:** o CSV vem em LATIN-1 e tem
  `;` dentro de campo entre aspas (leitura ingênua descartava 2.742 de 3.495
  linhas); e `Tipo de Boleto` estava sendo lida como identificador do título.
- **Chave de identificação definida com medição**, não com suposição: o
  relatório **não traz identificador de título**. A identidade na carteira é
  `matrícula + Dt Vcto + Vcto Origem`; a ligação com o Prime é
  `matrícula + Dt Vcto` e **só vale quando é inequívoca** — com mais de um
  candidato o título fica `AMBIGUO` e nenhum é escolhido (5 em 120 na amostra).
  O valor não desempata e não é usado para isso (só 23 de 120 linhas tinham
  "Saldo Original" igual ao `netAmount`).
- **`Dt Vcto` é o vencimento que rege a janela**, e isso foi medido: nas 35
  linhas em que ela difere de `Vcto Origem`, 21 tinham o aluno no espelho e as
  21 casaram com o Prime por `Dt Vcto`; nenhuma casou só por `Vcto Origem`.
- **Contato sem adivinhação.** O campo Telefone traz vários números; o sistema
  lê todos, usa quando há exatamente um e **separa** quando há mais de um
  (2.688 / 402 / 405 no arquivo real). E-mail idem (742 / 2.721 / 27), com uma
  caixa explícita — desmarcada por padrão — para usar o primeiro quando houver
  vários; a escolha fica gravada nos filtros da ação.
  Públicos simulados com o arquivo real: **WhatsApp 2.660**, **e-mail 724**,
  com todos os separados discriminados por motivo.
- **Acesso restrito à gestão nas três portas**, com teste para cada uma: RLS
  `force` em 11 tabelas, gate no início das **18 RPCs**, e a Edge Function
  conferindo `preventivo_e_gestao()` **no banco** antes de pedir a chave do
  Prime. Amanda ADM não passa em nenhuma — inclusive escrevendo direto pela API.
- **Isolamento verificado nos dois sentidos**, não só nas escritas do código
  novo: nenhuma migration, tela ou Edge Function da cobrança referencia `prev_`
  ou `preventivo_`; nenhuma tabela do Preventivo tem `aluno_id` (que faria
  `mesclar_aluno_duplicado()` escrever nela) nem par `*email*`/`nome` (que faria
  `propagar_nome_usuario()` trocar o nome do aluno pelo de um operador) — as
  colunas se chamam `celular_aluno` e `email_aluno` exatamente por isso.
- **Janela de 31 dias em America/Sao_Paulo**, e a saída não transfere nada: o
  teste compara o registro inteiro antes e depois e exige que só `status`,
  `saiu_em`, `saida_motivo` e `atualizado_em` mudem.
- **Exportar não é enviar:** `Preparada → Exportada → Envio confirmado` é ordem
  obrigatória e nada dispara mensagem, em nenhum ambiente.
- **121 testes do Preventivo** (85 em PostgreSQL real via PGlite + 36 de regra
  pura, incluindo a comparação caso a caso entre a normalização de celular da
  tela e a do banco). Build e lint limpos; a catraca de lint não piora.
- **Prévia funcional** das quatro abas, sem login e sem banco, com faixa
  declarando que os dados são inventados. O dublê lança erro se for carregado em
  build de produção, e há teste que reprova se `src/` passar a importá-lo.

## 🟡 Implementado, ainda não integrado

- **As três migrations não foram aplicadas** e a **Edge Function não foi
  implantada** — por isso **nenhum ciclo real de sincronização foi executado**.
  O que está provado da API vem de sondagem ao vivo (só leitura, pela Edge
  Function já existente `prime-acordo`) e do espelho `prime_extrato` coletado
  em 28/09.
- **O cron diário não foi criado.** O desenho proposto está em
  `docs/preventivo/README.md` §5: 1×/dia, uma chamada por aluno da carteira
  (~3.471/dia com a carteira atual), fila própria, concorrência 8, trava de
  execução simultânea no banco e retomada por `sinc_id`.
- **Formato dos arquivos da mensageria não conferido.** Hoje é um CSV genérico;
  falta o modelo de importação do CRM de mensageria.
- **Título cancelado não foi validado**: não havia exemplo confirmado para
  comparar. Está no pedido ao Prime.

## 🔴 Bloqueado por ausência de dados do Prime

- **Confirmação de pagamento.** O `financialStatement` tem 13 campos e nenhum é
  situação, status, saldo em aberto ou evento de pagamento.

  A prova **não usa o próprio campo** — usa variável independente, o relatório
  de inadimplência de 28/09, que diz por fora da API quem está em aberto.
  Cruzando 120 linhas com o espelho, 101 títulos ficaram confirmados como
  **EM ABERTO**. Desses 101: **101** tinham `paymentDate` preenchido, **19** com
  data posterior ao vencimento, **61** tinham `paidAmount` igual ao `netAmount`.
  As assinaturas que qualquer um leria como "pagou" aparecem em massa em
  títulos abertos. Comparando 101 abertos × 24 mensalidades de jul/ago × 315
  futuros dos mesmos alunos, **nenhum campo separa os grupos**.

  Também verificado que **não há outra fonte autorizada**: `/payments`,
  `/titles`, `/bills`, `/installments` e `/students/{reg}/titles` seguem 404
  desde 15/09; e `public.pagamentos` guarda `titulo_numero` de 5 dígitos — o
  número do **acordo** da Reativa —, incapaz de carregar pagamento de
  mensalidade do portador 95.

  **Por isso a classificação financeira foi retirada.** Os eventos são
  `VALOR_FONTE_CAIU` / `VALOR_FONTE_ZEROU` / `VALOR_FONTE_SUBIU`: alteração do
  `netAmount`, que é o valor do título na fonte, não um valor em aberto. Um
  teste lê a restrição da tabela e reprova se "saldo", "pagamento", "liquid",
  "receb" ou "quita" aparecerem num tipo de evento. No painel, no lugar de
  "valor recebido", está escrito o motivo pelo qual esse número não existe.

  **O pedido técnico exato ao responsável pelo Prime**, pronto para encaminhar,
  está em `docs/preventivo/README.md` §4 — com as três opções de fonte, o
  pedido de incluir o número do boleto no próprio relatório de inadimplência e o
  pedido dos quatro exemplos conhecidos (pago, aberto, a vencer, cancelado).

---

## Sobre o portador 95

Aparece só como **informação técnica**: é onde a mensalidade corrente vive no
Prime, e é por isso que sabemos onde procurar o título de cada linha do
relatório (das 120 conferidas, 101 casaram no portador 95 e zero no 195).
**Não é público automático** — a carteira é sempre o arquivo importado, e nada
entra nela por varredura. Os números de abrangência (302.477 linhas, 19.795 a
vencer, 7.182 em 1–31 dias) são do **espelho de 17.744 alunos**, não da base
inteira da ULBRA, e estão marcados assim na documentação.

## Documentação

`docs/integracoes/` atualizado no mesmo commit, como manda o `CLAUDE.md`:
`prime-api.md`, `prime-api-catalog.json`, `prime-mapa-fontes-verdade.md`,
`prime-mapa-identificadores.md`, `prime-gaps.md`, `prime-edge-functions.md`.
Operação e pedido técnico em `docs/preventivo/README.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
