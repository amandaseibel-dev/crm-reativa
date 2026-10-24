# Reconciliação de dono e acionamento entre ficha e caso — 2026-10-19

Origem: o diagnóstico da aluna Bruna Cristine Pavao Vinder, que é a interseção
de quatro defeitos pequenos e independentes. Tudo aqui foi **medido em produção
em 19/10/2026, somente leitura**. Nenhuma migration foi aplicada, nenhum
responsável foi alterado, nenhuma ficha foi unificada.

## A causa raiz, em uma frase

O dono de um aluno mora em **dois** lugares, cada ferramenta lê **um** deles, e
os dois só são alinhados por gatilhos que exigem **mudança** — então um caso que
**nasce** desalinhado permanece desalinhado para sempre.

| campo | quem lê |
|---|---|
| `alunos.responsavel_atual_email` | a **fila operacional** (`FilaOperacional.jsx`, filtro `MINHA_FILA`) |
| `casos.operador_email` | a **Carteira Geral** (`carteira_geral_base.dono_email`) e as **6 rotinas de distribuição** que pescam quando está `NULL` |

Os gatilhos de alinhamento (`_sync_casos_resp_aluno`,
`fn_sync_acionamento_alunos_para_casos`) exigem `is distinct from old`. **Nada
preenche no nascimento.**

A consequência medida: dos 8 alunos com saldo cuja ficha é da Olga, os **4
vivos** têm o caso em `operador_email = NULL`. Ou seja: a ficha diz "Olga" e o
caso está na **fila livre** ao mesmo tempo. Eles são invisíveis no painel da
Carteira Geral filtrando por responsável (aparecem como `SEM_OPERADOR`) **e**
pescáveis pelo nivelamento das 09:20 a qualquer momento.

## População afetada, sem dupla contagem (item 6)

| classe | alunos | saldo | a Bruna está? |
|---|---|---|---|
| `DONO_INATIVO` — ficha de operador desligado | 8 | R$ 104.965,66 | sim |
| `CASO_SEM_OPERADOR` — caso vivo sem dono, ficha com dono | 15 | R$ 89.419,09 | sim |
| `CASO_SEM_ACIONAMENTO` — caso sem data, ficha com data | 1 | R$ 4.291,04 | **só ela** |
| `FICHA_DUPLICADA` — nome repetido com CPF reprovado no dígito | 14 | R$ 106.073,40 | sim |
| **soma ingênua (ERRADA)** | **38** | **R$ 304.749,19** | — |
| **UNIÃO REAL** | **32** | **R$ 276.946,18** | — |

A soma ingênua inflaria em **6 alunos e R$ 27.803,01**. Por isso
`reconciliacao_dono_caso_aluno()` devolve **uma linha por aluno** com uma coluna
booleana por classe e um array `classes` — nunca uma linha por classe.

Atribuição das causas, pela assinatura de quem criou o caso:

- os 15 sem operador: **14** do script avulso de 11/09 (`sistema_caso_faltando`,
  INCIDENTE-513-FICHAS) e **1** de `gestao_excecao_conciliacao`;
- perfil do responsável desses 15: **11 operador ativo, 4 operador inativo,
  ZERO gerência/ADM/supervisão**;
- os 8 do operador desligado: **todos de `cobranca03` (Olga)**, 4 já com caso
  encerrado, **2 com fidelização vigente**;
- `public.recuperar_valor_automatico` — função **viva, fora de cron** — insere
  caso com `operador_email` NULL explícito e **sem** `data_ultimo_acionamento`:
  já criou **420** casos nesse formato. É a porta pela qual o defeito renasce.

## O que esta PR entrega

Uma migration com **4 objetos novos**. Não altera, não substitui e não reconcede
nada do que já existe.

| objeto | o que é | estado ao aplicar |
|---|---|---|
| `cpf_digito_valido(text)` | dígito verificador, IMMUTABLE | ativo |
| `reconciliacao_dono_caso_aluno(jsonb)` | diagnóstico, uma linha por aluno | ativo, portão de gestão |
| `fichas_duplicadas_revisao(int)` | fila de revisão humana | ativo, portão de gestão |
| `trg_caso_herda_do_aluno` | BEFORE INSERT em `casos` | **DESABILITADO** |

### Item 1 — operador inativo → Carteira Geral

**Não há máquina nova a construir: ela já existe em produção.** Conferido no
corpo vivo em 19/10:

- destino é titular próprio `carteira.geral@reativa.local`
  (`usuarios`, perfil `carteira`, `ativo=false`, sem linha em `auth.users`), com
  **371 casos** já sob ele;
- `carteira_geral_mover(p_previa_id, p_motivo)` **não toca
  `data_ultimo_acionamento` nem `data_retorno`** → a **fidelização vigente é
  preservada** e nenhum retorno artificial nasce;
- exige uma **prévia** (`carteira_geral_previa`) → revisão humana antes de mover;
- grava `carteira_geral_auditoria` (append-only) e tem
  `carteira_geral_desfazer_lote` → **histórico preservado e reversível**;
- o destino **não é operador**, então mover para lá **não redistribui entre
  operadores**;
- a blindagem contra o cron das 08:20 está **viva**:
  `casos_elegiveis_liberacao_fidelizacao` já referencia `carteira_geral_email()`,
  então a custódia não cai na fila livre no 11º dia;
- `cobranca03.recebe_novos_casos` já está **false** — ela não recebe mais nada.

O que faltava era a **identificação**, e é só isso que esta PR adiciona:
`reconciliacao_dono_caso_aluno('{"classe":"DONO_INATIVO"}')` devolve os 8 com
saldo, fidelização vigente e flag de bancada. A partir daí o caminho é o que já
existe — prévia, conferência humana, `carteira_geral_mover` — e **depende da sua
autorização**, não desta PR.

### Item 2 — herança no nascimento do caso

`trg_caso_herda_do_aluno`, BEFORE INSERT em `casos`, em **um** lugar em vez de em
cada caminho que cria caso (hoje: `recuperar_valor_automatico`, o front em
`CasosSemValor.jsx`, scripts de incidente):

1. nunca sobrescreve valor que o INSERT trouxe explicitamente;
2. `data_ultimo_acionamento`: herda da ficha quando vier NULL, com o cast
   `America/Sao_Paulo` (o campo do caso é `date`, o da ficha é `timestamptz`);
3. `operador_email`: herda **só** quando o responsável é perfil `operador`;
4. nunca levanta exceção — criar caso não pode falhar por alinhamento.

**Ação massiva não é tratada como contato humano.** O campo herdado é o próprio
`alunos.data_ultimo_acionamento`, que é o único valor que todo o sistema já
chama de "último acionamento". Esta PR **não** cria semântica nova e **não**
reclassifica movimentação alguma.

> **A alternativa que eu descartei, e por quê.** Herdar só o último contato
> **humano** (excluindo os dois tipos massivos) criaria um significado para
> `casos.data_ultimo_acionamento` diferente do de `alunos` — e seria instável:
> `fn_sync_acionamento_alunos_para_casos` sobrescreveria esse valor na primeira
> mudança da ficha, porque a guarda dela é `c.data_ultimo_acionamento < v_dia`.
> Se você quiser essa semântica, ela exige mudar também aquele gatilho, o que é
> uma decisão maior do que esta PR. **É sua a palavra final.**

**NÃO cria retorno artificial:** `data_retorno` não aparece do lado esquerdo de
nenhuma atribuição, em nenhum dos 4 objetos.

### Item 3 — os 15 sem operador e a regra segura de sincronização

A regra segura é a do próprio gatilho (item 2), com a **exceção da bancada**:
quando o responsável da ficha é `gerencia`, `administrativo` ou `supervisor`, o
caso **não** herda o dono. É a mesma exceção que `_aluno_segue_dono_do_acordo` já
aplica em produção ("lançamento feito pela bancada NÃO muda o dono") — foi ela,
inclusive, que impediu a ficha da Bruna de ir para a gerência em 29/09, e
corretamente.

**Medição que importa: zero dos 15 tem responsável de bancada** (11 operador
ativo, 4 inativo). Então a exceção é **preventiva, não corretiva** — ela não
muda nada na população de hoje, e está no código para o caso futuro.

Os 15 existentes **não** são corrigidos por esta PR: são listados pelo
diagnóstico. Corrigi-los é escrita de responsável em produção, fora do escopo
autorizado.

### Item 4 — fichas duplicadas, com revisão humana

`fichas_duplicadas_revisao()` entrega **uma linha por ficha**, agrupada por
`nome_normalizado`, para grupos que têm (a) mais de uma ficha, (b) CPFs
divergentes e (c) ao menos um CPF **reprovado no dígito verificador**. Colunas de
evidência: `cpf_valido`, `matricula`, `telefone`, `email`, `saldo_total`,
`qtd_casos`, `qtd_movimentacoes`, `mesma_matricula_no_grupo`,
`mesmo_telefone_no_grupo`.

**Não unifica, não apaga, não move nada** — nem como função desligada. Unificação
cadastral não foi autorizada e não está implementada aqui.

Medido: **45** nomes com ficha repetida e CPF divergente; **26** com CPF
inválido; **9** desses com a **mesma matrícula** (assinatura forte de mesma
pessoa, que é o padrão da Bruna); **14 fichas com saldo**, R$ 106.073,40.

O caso da Bruna, com duas provas independentes:

| | ficha com dívida | ficha zerada |
|---|---|---|
| CPF | `049…043` | `004…504` (o mesmo deslocado um dígito) |
| dígito verificador | **válido** | **inválido** |
| linhas no `prime_extrato` | **50** | **0** |

### Item 5 — verificação das parcelas da Bruna no Prime oficial

Seguindo `docs/integracoes/README.md` (consulta obrigatória), a conclusão é
**documentada e negativa**, e é exatamente por isso que a ausência no
`prime_extrato` **não** prova inadimplência:

- **estrutura do acordo (parcelas, vencimentos, valor negociado): NÃO
  LOCALIZADA** em nenhuma rota testada. Censo de produção:
  `auditoria.ACORDO_ENCONTRADO_NA_API = 0` — `/agreements` **nunca** devolveu
  lista preenchida. Está visível **na tela do Prime**;
- **situação do título (pago / aberto / cancelado): NÃO EXPOSTA.** `paymentDate`
  vem preenchido em **100%** das linhas, inclusive em título a vencer (0 de
  302.477 nulos no portador 95), e `paidAmount` é valor de tabela. Nunca aceitar
  `paymentDate` isolado como prova de pagamento;
- prova local da limitação: **o boleto da entrada dela (`50672320001`), que
  sabidamente foi paga em 27/07, também tem 0 linhas no `prime_extrato`.** A
  ausência dos boletos do acordo é a regra, não sinal de não pagamento.

**Roteiro da verificação (manual, na tela, por você ou pela operação):**

1. identificador correto é a **`registration` = `221005235`** — vem do
   `prime_extrato`, **não** de `alunos.matricula` (que é `12340`, a matrícula de
   import do CRM; `prime-mapa-identificadores.md` diz expressamente para não
   assumir que são iguais);
2. na tela do acordo, conferir as duas parcelas vencidas: **`50672320002`
   (venc. 27/08, R$ 858,20)** e **`50672320003` (venc. 27/09, R$ 858,20)`**;
3. aceitar como prova de pagamento **só** a baixa na tela com data e valor, ou
   extrato bancário. Não aceitar `paymentDate` da API;
4. opcional, como evidência **auxiliar** do lado da mensalidade (não do acordo):
   `prime-sonda` → `financial_statement` para a `registration 221005235`. Serve
   para existência, vencimento e decomposição de valor — **nunca** para situação
   de pagamento;
5. ponta aberta já localizada, a conferir no mesmo movimento: há **1 liquidação
   no Prime em 05/10, R$ 4.471,14**, para um título com vencimento 05/09 no CPF
   dela, portador Santander. Pela regra de entrada vigente, *Prime liquidado não
   é pagamento* — mas é o que mais se parece com dinheiro recente dela e merece
   o olhar humano.

## Riscos

| risco | mitigação |
|---|---|
| **Ligar o gatilho muda distribuição**: caso que nascia na fila livre passa a nascer com dono, e sai do alcance das 6 rotinas | o gatilho é criado **DESABILITADO**. Aplicar a migration é comprovadamente inerte (teste dedicado). Ligar é 1 instrução, com autorização separada |
| **Ligar o gatilho muda fidelização**: caso que nasce com data fica protegido por até 10 dias (`caso_dentro_prazo_fidelizacao(NULL)` é false hoje) | mesmo controle acima. O efeito é conservador (protege, não move), e está no teste |
| Herdar dono **inativo** mantém o aluno com quem saiu | é deliberado e menos grave que o estado atual: impede ficha-com-dono + caso-na-fila-livre simultâneos. Trocar dono é trabalho do `carteira_geral_mover`, com prévia |
| Herança de bancada deixaria o caso em NULL (= fila livre) | a exceção **não** preenche, mas o diagnóstico lista com `dono_e_bancada=true`. Hoje a população é **zero**; se passar a existir, aparece na fila de revisão |
| `cpf_digito_valido` reprovar CPF legítimo e gerar falso duplicado | o grupo só é formado com **nome repetido E CPFs divergentes E** dígito inválido; a saída traz matrícula e telefone para o humano decidir. Teste cobre o homônimo com dois CPFs válidos, que **não** entra |
| Função nova herdar `EXECUTE` para `public`/`anon` pelo default do Postgres | `revoke all ... from public, anon` explícito nas 3 funções, mais portão `usuario_e_gestao()` **no corpo**, não só na concessão |
| Vazar aluno, CPF e saldo para operador comum | portão de gestão no corpo; teste prova `42501` para quem não é gestão |

## Validação de regressão

| checagem | resultado |
|---|---|
| `supabase/tests/reconciliacao_dono_caso_aluno.test.js` (PGlite, Postgres real) | **22/22** |
| `supabase/tests/carteira_geral_comportamento.test.js` (vizinho mais próximo, mexe nos mesmos campos) | **114/114** |
| catraca de migrations (`scripts/ci/catraca-migrations.mjs`) | exit 0 |
| migration altera corpo de função existente? | **não** — só `create or replace` de 4 nomes novos |
| migration escreve em alguma tabela? | **não** — objetos 1-3 são IMMUTABLE/STABLE (o Postgres recusa DML, `0A000`); o objeto 4 está desabilitado |
| `data_retorno` do lado esquerdo de atribuição? | **nenhuma ocorrência** |
| pagamento / baixa / acordo / parcela / título / saldo alterados? | **nenhum** — nenhum `insert`/`update`/`delete` em lugar nenhum |
| rollback | arquivo próprio, testado: derruba os 4 objetos e o gatilho, 0 restantes |

O teste prova as duas pontas do gatilho: **desabilitado**, o caso continua
nascendo `NULL/NULL` como hoje (garantia de regressão); **habilitado dentro de
uma transação**, herda data e dono, respeita a bancada, tira o caso da fila
livre, não cria retorno e preserva a fidelização vigente.

## O que esta PR NÃO faz — e precisa da sua autorização

1. **não aplica a migration** (nem via `apply_migration`);
2. **não liga** `trg_caso_herda_do_aluno`;
3. **não move** nenhum dos 8 para a Carteira Geral;
4. **não corrige** os 15 casos sem operador nem o 1 sem acionamento;
5. **não unifica** nenhuma ficha duplicada;
6. **não altera** pagamento, baixa, acordo, parcela, saldo ou responsável;
7. **não mexe** nas PRs existentes (#692 mesclada, #694 em draft — e a #694 não
   cobre nada daqui: a Bruna tem 0 acordos e 0 parcelas canceladas);
8. **não toca** nas regras gerais de distribuição.
