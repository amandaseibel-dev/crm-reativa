# Painel de Produtividade Operacional — proposta (22/10/2026)

Terceira frente paralela. Branch `feat/painel-produtividade-operacional`,
worktree `/Users/amandapradoseibel/Documents/crm-reativa-produtividade`,
partindo de `origin/main` em `dbb4ad91`.

Nada implementado. Nada aplicado no Supabase. Nenhuma migration.

---

## 1. O que já existe de gerencial

| Tela | Rota | Fonte | O que já cobre |
|---|---|---|---|
| Efetividade | `/efetividade` | `calibragem_efetividade` | **Por operador:** carteira, cobertura %, trabalhados, **acionamentos**, acordos, conv. acordo %, pagamentos confirmados, recuperado, links, termos, aguardando confirmação. Mais saúde da carteira e funil. |
| Calibragem | `/calibragem` | `calibragem_visao_operadores`, `calibragem_funil`, `calibragem_listar_casos` | Visão por operador + simulação/nivelamento. Restrita a 3 e-mails. |
| Relatórios (Tabulações) | `/relatorios` | `aluno_movimentacoes` | Ranking de tabulações por operador, média por operador/dia. Gate `podeVerTudo`. |
| Acordos por Operador | `/acordos-operador` | `carteira_acordos_por_operador` | Acordos por operador + detalhe. |
| Saúde da Base | `/saude-da-base` | `saude_da_base`, `saude_base_lista`, `saude_base_tendencia` | Pendências estruturais, tendência de score dos últimos dias, equilíbrio entre operadores. |
| Panorama 360 / Minha Carteira | `/painel-carteira` | `PainelCarteira.jsx` | Carteira e retornos — **componente compartilhado, 2.7k+ linhas**. |
| Meu Dashboard | `/meu-dashboard` | `aluno_movimentacoes`, `alunos` | Do **próprio** operador, filtrado por `registrado_por_email = eu`. |
| Gestão Financeira de Operadores | `/financeiro-operadores` | `rh_*` | Comissão e fechamento. |
| Taxa de Conversão | `/taxa-conversao` | `taxa_conversao` | — |
| Projeção Hora a Hora | `/projecao-hora-a-hora` | snapshots | **Frente Santander está mexendo aqui.** |

### Dois achados que mudam a proposta

**a) `PainelOperadores.jsx` existe, está pronto e nunca roda.**
`src/App.jsx:45` importa o componente por `lazy()` e **não há nenhum `<Route>`
que o renderize** — 1 única ocorrência do nome no arquivo inteiro. A rota
`/painel-operadores` está na lista de permissões do perfil `admin`
(`src/App.jsx:208`), mas não há rota nem item de menu. São 258 linhas que já
leem `ponto_operadores` + `usuarios` e mostram ponto, pausas (intervalo 1,
intervalo 2, almoço) e horas por operador/dia, com filtro de período.
A fonte está **viva**: 6.735 linhas, última em 21/10/2026 22:32.

**b) `/painel-geral` é rota órfã.**
`PainelGeral` (RPC `painel_geral`, gate `podeVerTudo`) entrega exatamente um
360 de Operacional / Carteira / Pagamentos com filtro por operador — casos
ativos, base total, sem responsável, sem contato +10 dias, em negociação 24h,
retornos hoje, casos ativos por operador, CPFs e valor por operador, recebido e
honorários por operador. Tem `<Route>` (`src/App.jsx:1178`) e está nas
permissões de `admin` e `supervisor`, mas **não tem item de menu** — só se
chega por URL digitada.

---

## 2. Indicadores disponíveis — medidos em produção em 22/10/2026

### Fontes vivas

| Fonte | Medição | Serve para |
|---|---|---|
| `aluno_movimentacoes` | 50.353 linhas em 30 dias; última hoje 08:55; **16 operadores distintos em 7 dias; 0 linhas sem autor** | Acionamentos, tabulações, série por dia e por operador |
| `ponto_operadores` | 6.735 linhas, última 21/10 22:32 | Presença, pausas, horas |
| `alunos.data_retorno >= hoje` | 12.932 | Retornos agendados e vencidos |
| `casos.data_ultimo_acionamento` | 18.150 preenchidos | Último toque por caso |

Tipos de acionamento individual nos últimos 7 dias:
`FINALIZACAO_ATENDIMENTO` 3.500 · `EM_ATENDIMENTO` 99 · `QUITADO_MANUAL` 36 ·
`LINK_ENVIADO_AO_ALUNO` 21 · `RETORNO_TERMO` 16 ·
`COMPROVANTE_ENVIADO_BAIXA` 10 · `BAIXA_REALIZADA` 0.

### Fontes mortas — não propor nada sobre elas

| Fonte | Estado |
|---|---|
| `historico_operacional` | 34.330 linhas, mas `aluno_id`, `data_acao` e `acao_realizada` **100% nulos**; parou em 30/06 |
| `historico_casos`, `historico_atendimentos`, `operador_atendimentos` | 0 linhas |
| `casos.ultima_tabulacao_em` | nula em 18.424/18.424 |

### Dois limites que preciso dizer antes de prometer tela

**"Retornos cumpridos" não é mensurável hoje.**
`alunos.retorno_confirmado_em` está preenchido em **0 linhas**. O campo existe e
a tela já sabe escrever nele (`PainelCarteira.jsx:2407`), mas ninguém usa. Quem
vai passar a alimentá-lo é a frente **Meu Dia** (`src/utils/painelMeuDia.js` já
lê `retorno_confirmado_em`). Então este indicador **fica fora desta etapa** —
entra quando a outra frente o ligar, sem proxy inventado no meio.

**Não existe série histórica por operador.**
Nenhum snapshot diário de carteira por operador. As séries que existem
(`saude_base_tendencia`, `projecao_historico_diario_ler`,
`carteira_saldo_historico_por_ano`) são de base, de projeção financeira e de
saldo por ano — nenhuma por operador. Logo, "evolução da carteira por operador"
só pode ser:

- **(a)** série de **eventos** reconstruída de `aluno_movimentacoes` — retroativa
  e confiável, porque cada linha tem data e autor; ou
- **(b)** foto atual com delta entre início e fim do período.

Série de **saldo** por operador exigiria tabela de snapshot nova — migration,
que está fora do que você autorizou nesta frente.

### Já existem 3 definições divergentes de "acionamento"

| Onde | Lista |
|---|---|
| `src/utils/carteiraAcionada.js:30` | 7 tipos — **canônica**, decisão da gestão de 29/09/2026, com testes e contagens de produção no comentário |
| `src/components/PainelCarteira.jsx:594` | 2 tipos (`FINALIZACAO_ATENDIMENTO`, `FINALIZACAO`) |
| `src/pages/MeuDashboard.jsx:12` | 11 tipos |

Mais a contagem própria do banco dentro de `calibragem_efetividade`. Uma quarta
lista no painel novo seria métrica artificial. **O painel importa
`TIPOS_ACIONAMENTO_INDIVIDUAL` de `carteiraAcionada.js` e não redefine nada.**

---

## 3. Proposta

Uma tela, `/produtividade`, "Produtividade Operacional", seção Gestão, gate
`podeVerTudo` (o mesmo de `/painel-geral` e `/relatorios` — Amanda, Fernanda,
Amanda ADM, mais perfil `diretoria`). Cinco blocos, nenhum indicador novo
inventado:

**Bloco 1 — Presença × produção (o único que não existe em lugar nenhum).**
`ponto_operadores` (horas e pausas do dia) ao lado da contagem de acionamentos
do **mesmo** operador no **mesmo** dia. Os dois lados já existem prontos; o que
não existe é o cruzamento. Resgata as 258 linhas do `PainelOperadores.jsx` que
hoje não rodam.

**Bloco 2 — Acionamentos por operador e por dia.**
De `aluno_movimentacoes` com a lista canônica. **Sobreposição declarada:** a
Efetividade já mostra `acionamentos` por operador como total do período. A
diferença é a quebra por dia (ver quem caiu na quarta, não só o total do mês).
Se você achar que não paga o preço, este bloco vira um link para
`/efetividade` — decisão sua.

**Bloco 3 — Pendências por operador.**
Reusa o que o banco já calcula em `painel_geral`: sem responsável, sem contato
+10 dias, em negociação 24h, retornos de hoje. Nenhuma regra nova.

**Bloco 4 — Retornos.**
Agendados e vencidos, de `alunos.data_retorno`. **Cumpridos não entra**, pelo
motivo da seção 2.

**Bloco 5 — Evolução.**
Série de eventos por dia (acionamentos, acordos, pagamentos confirmados) e
delta da carteira entre as pontas do período. Sem snapshot novo.

---

## 4. Arquivos envolvidos

**Novos**
- `src/pages/ProdutividadeOperacional.jsx`
- `src/pages/ProdutividadeOperacional.test.jsx`
- `src/utils/produtividade.js` — só agregação pura, sem React e sem banco
- `src/utils/produtividade.test.js`

**Alterado — um só, e é compartilhado**
- `src/App.jsx`: 1 `lazy()` import, 1 `<Route>`, 1 item de menu na seção Gestão,
  a rota nas listas de `permissoes` de `admin` e `supervisor`.

**Reuso sem alterar**
`src/utils/carteiraAcionada.js` (lista canônica) · `src/utils/paginado.js`
(`buscarTudo`, por causa do teto de 1.000 linhas da API) ·
`src/utils/operadores.js` (`podeVerTudo`) · `src/utils/periodo.js` ·
`src/ui/estados.js` · `src/components/AvatarFoto.jsx`

**Decisão sua**
`src/pages/PainelOperadores.jsx` — religar a rota própria dele, ou absorver o
conteúdo no Bloco 1 e apagar o import morto do `App.jsx`.

---

## 5. Risco de conflito

| Frente | Arquivos | Choque |
|---|---|---|
| **Santander** (`feat/santander-previa`) | `src/pages/ProjecaoHoraHora.jsx`, `supabase/config.toml`, `supabase/functions/santander-previa/*` | **Nenhum.** Zero interseção. |
| **Meu Dia** (`ui/meu-dia-operador-visual`) | nenhum — a branch está em `dbb4ad91`, igual à `origin/main`, e o worktree está limpo | **Nenhum hoje.** Quando ela mexer em `painelMeuDia.js` / `PainelCarteira.jsx`, continuo sem tocar nesses arquivos. A única amarra é o `retorno_confirmado_em`, que eu deliberadamente deixo de fora. |
| **Qualquer frente que adicione rota** | `src/App.jsx` | Possível, e resolve-se em 1 linha. É o preço de qualquer tela nova neste repo. |

**Não toca:** Supabase, migrations, edge functions, financeiro, Santander,
Meu Dia, TV, `PainelCarteira.jsx`, `src/components/projecao/*`.

---

## 6. O que preciso decidir com você

1. `PainelOperadores` (ponto/pausas, pronto e desligado): rota própria de volta,
   ou absorvido no Bloco 1?
2. Bloco 2 (acionamentos por dia): série nova, ou só link para a Efetividade?
3. `/painel-geral` está órfã do menu. Entra no menu nesta frente, ou fica como
   está?

---

# 7. Decisão da gestão e implementação (22/10/2026)

As três decisões foram aprovadas: **absorver o PainelOperadores**, **série
diária de acionamentos** e **incluir `/painel-geral` no menu** (este último com
cinco condições: só o acesso no menu, respeitar as permissões já configuradas,
não mudar o funcionamento nem os indicadores, não duplicar item e ir na mesma
PR).

## 7.1 O que foi feito

| Arquivo | O quê |
|---|---|
| `src/pages/ProdutividadeOperacional.jsx` | **novo** — a tela, cinco blocos, só leitura |
| `src/utils/produtividade.js` | **novo** — agregação pura, sem React e sem banco |
| `src/utils/produtividade.test.js` | **novo** — 32 testes |
| `src/pages/ProdutividadeOperacional.test.jsx` | **novo** — 14 testes (tela + ligação no `App.jsx`) |
| `src/pages/PainelOperadores.jsx` | **removido** — absorvido no bloco 1 |
| `src/App.jsx` | import, `<Route>`, porta em `RotaProtegida`, item de menu, item do Painel Geral, remoção da rota morta |
| `src/utils/acessoFilaUnicaConfirmacao.test.js` | 1 asserção generalizada (ver 7.4) |

Zero migration, zero RPC nova, zero escrita. A tela não tem um único botão de
ação.

## 7.2 Quem entra, e por que não é permissão nova

Os três logins de gestão têm **três perfis diferentes** no banco: Amanda é
`gerencia`, Fernanda é `supervisor`, Amanda ADM é `administrativo` (cada perfil
com um único usuário ativo). Uma lista por perfil não consegue descrever "a
gestão" sem abrir para quem não é — então `/produtividade` **não entra** nas
listas de `permissoes` e é decidida em `RotaProtegida` por `podeVerTudo(email)`,
chamado só com o e-mail. Isso devolve exatamente esses três, que são os mesmos
de `public.usuario_e_gestao()` — a função que a RLS de `ponto_operadores` já
exige para ver a batida dos outros. É o mesmo padrão já documentado no repo para
a Fila Única de Confirmação (tela por PESSOA, não por perfil), e o item de menu
usa a mesma regra da porta, senão ele sumiria para todos.

## 7.3 Painel Geral: só o menu, e ele já estava certo

Adicionado **um** item (`secao: "Gestão"`). A rota, a `<Route>`, a tela e as
duas listas de permissão (gerência e supervisor) ficaram como estavam — há teste
travando cada uma dessas quatro coisas.

**Por que não liberar para a Amanda ADM:** a própria RPC `painel_geral` só
aceita `amanda.seibel` e `cobranca04` — a Amanda ADM não está no gate dela e
receberia "Sem permissão" com a tela vazia. As listas por perfil já a excluíam.
Mudar isso seria mexer no funcionamento do Painel Geral, que a decisão proibiu;
se a gestão quiser incluí-la, é alteração na RPC (migration) e vira frente
própria.

## 7.4 Um teste existente teve de ser generalizado

`acessoFilaUnicaConfirmacao.test.js` exigia a linha de import **literal**
(`import { podeGerirFinanceiro } from "./utils/operadores"`). Como `podeVerTudo`
vem do mesmo módulo, a linha passou a ter dois nomes. A asserção virou regex que
cobra o que ela queria cobrar: que `podeGerirFinanceiro` venha DALI, e não de
uma lista nova. As outras quatro asserções do arquivo continuam intactas.

## 7.5 Medições novas, feitas durante a implementação

| Fonte | Medição em 22/10/2026 | Efeito na tela |
|---|---|---|
| `ponto_operadores.tipo` | `PAUSA_INTERVALO_1` e `_2`: **0 registros na história**. `PAUSA_ALMOCO`: 3, último em 02/07 | As três colunas de pausa viraram **uma** só; três colunas vazias por construção são ruído |
| LOGIN × LOGOUT | 4.128 × 2.606 no total | parecia metade sem jornada… |
| dias-operador (30 d) | **229 de 239 com as duas pontas (95,8%)** | …mas não é: o desequilíbrio vem de logins repetidos no mesmo dia. A jornada é mensurável quase sempre |
| `alunos.data_retorno` | tipo **`date`** | confirma a regra do fuso: converter para `Date` voltaria um dia na coluna inteira |
| colunas lidas | 21 conferidas em `information_schema` | nenhuma leitura em coluna inexistente |

## 7.6 Verificação

- **46 testes novos** verdes em `TZ=UTC`, `America/Sao_Paulo` e `Asia/Tokyo`
  (fuso não muda resultado).
- **Catraca do lint: exit 0**, e o número caiu de 473 para 471 — a remoção da
  tela morta levou os dois erros dela embora. A linha de base **não** foi
  regravada (a catraca aceita melhora; baixar o número é decisão separada).
- **Build**: `vite build` concluiu.
- **Suíte de front (`src`)**: executada em série, sem falha.
- `supabase/tests/acordo_cancelado_nao_reabre_mensalidade_comportamento.test.js`
  falha em 2 casos por **timeout de 5 s** — são os dois `it(...)` daquele
  arquivo que não recebem timeout explícito, enquanto os vizinhos levam de 14 a
  77 s contra Postgres real (PGlite). Não é efeito desta frente: o arquivo não
  foi tocado, roda SQL em Postgres embutido e **não importa nada de `src/`** —
  os únicos arquivos que esta PR altera. Não cheguei a rodá-lo no commit-base
  para comparar; a afirmação vem do que o arquivo importa, não de medição.
- A verificação no navegador exige o login da gestão, que é da Amanda. A tela
  foi verificada renderizando o componente com fixtures no formato da produção
  (jsdom) e conferindo número por número.

## 7.7 Risco de conflito, reconferido no fim

| Frente | Estado em 22/10 | Choque |
|---|---|---|
| Santander | `ProjecaoHoraHora.jsx`, `supabase/functions/santander-previa/*`, `supabase/config.toml` | nenhum |
| Meu Dia | branch em `dbb4ad91` (= `origin/main`), worktree limpo | nenhum. A amarra é o campo de retorno cumprido, que ficou deliberadamente fora |
| Outra frente que adicione rota | `src/App.jsx` | possível, resolve em 1 linha |
