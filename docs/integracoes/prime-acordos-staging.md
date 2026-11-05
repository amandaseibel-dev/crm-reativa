# Staging da integração ACORDOS (Mannesoft Prime → ReATIVA One)

Consolida as decisões das rodadas de diagnóstico sobre identidade, composição
e atualização financeira dos ACORDOS, e registra o escopo desta primeira
etapa de desenvolvimento. Ver [prime-arquitetura.md](prime-arquitetura.md)
para o diagrama geral da integração Prime/ULBRA — este documento cobre só a
frente de ACORDOS, que **não é** a estrutura financeira hoje lida pela API
(ver [prime-mapa-fontes-verdade.md](prime-mapa-fontes-verdade.md), linha
"Estrutura do acordo").

## Decisões já fechadas (não reabrir)

1. **Identidade do acordo** = número do acordo no Mannesoft + identificador
   estável do aluno (CPF). **Carteira/portador nunca é parte da chave** —
   não foi comprovado que um acordo fica preso à mesma carteira durante todo
   o seu ciclo de vida, e tratá-la como identidade arriscaria duplicar o
   mesmo acordo caso ela mude entre duas capturas. É atributo versionado.
2. **`numero_ulbra` não é chave única.** Medido em produção: 20,1% dos
   5.055 acordos sem valor, 17 valores repetidos com status conflitantes
   entre si (ex.: um ATIVO + um CANCELADO do mesmo número). Nunca usado como
   identidade nesta integração.
3. **`duplicado_de`/`duplicado_marcado_em` não são reutilizados.** Têm dono
   já wired em produção (`tg_acordo_bloquear_duplicado`,
   `acordos_sinalizar_boleto_repetido`), lidos por `acordos_duplicados_sinalizados()`
   (tela de gestão) e por `tv_snapshot_atualizar()` (ranking de operadores na
   TV). Escrever neles por fora interferiria nos dois.
4. **Composição = grupo, nunca correspondência individual.** A integração
   preserva o conjunto de títulos negociados e o conjunto de títulos gerados
   exatamente como a tela do Acordo-Detalhe mostra. Nunca inventa qual
   título negociado específico foi substituído por qual título gerado
   específico além do que o Mannesoft explicitar — é exatamente o erro já
   invalidado em produção (regra de `paymentDate` igual = mesmo acordo,
   revertida em 1.217 vínculos; correspondência por últimos dígitos do
   boleto, 56,3% de acerto).
5. **Quitação observada no Mannesoft nunca aciona baixa.** `quitar_acordo_cartao()`
   grava uma baixa como se o pagamento tivesse ocorrido agora, neste
   sistema — usá-la para refletir algo só observado no Mannesoft forjaria um
   evento financeiro que não aconteceu aqui. Gera alerta, sempre.
6. **Toda atualização financeira passa por rotina oficial, nunca `UPDATE`
   direto**: acordo novo → `importar_acordos()`; cancelamento → `cancelar_acordo_ficha()`
   (nunca `acordo_cancelar()`, que não tem a guarda de permissão nem o
   bloqueio tudo-ou-nada); confirmação → molde de
   `fila_acordos_confirmar_automatico()`; vínculo de título → `acordo_vinculo_sugestao_confirmar()`,
   só quando o nível calculado por `acordo_vinculo_sugestoes_calcular()` for
   `FORTE`.
7. **Indeterminado = exceção**, nunca automático por omissão — mesmo
   princípio do Guardião (`plugins/reativa-one/hooks/guardiao.sh`:
   "INDETERMINADO = NEGA").

## Cenários de renegociação (segunda etapa de desenvolvimento)

Adicionados sem reabrir nenhuma das decisões da primeira etapa:

- **Acordo cancelado e refeito / renegociações sucessivas.** Um novo acordo só
  é tratado como continuação de um anterior (`REACORDO_APOS_CANCELAMENTO`)
  quando a própria captura traz uma referência explícita ao acordo anterior
  (`acordoAnteriorMannesoft`) **e** esse acordo anterior já está confirmado
  como `CANCELADO` no staging. Nunca por proximidade de data, valor ou CPF
  repetido — é exatamente o tipo de inferência já invalidado em produção.
  `montarCadeiaReacordo()` resolve a cadeia (A→B→C→...) seguindo essas
  referências elo a elo; a cadeia termina no primeiro elo sem referência
  explícita, sem presumir continuidade.
- **Parcelas herdadas de acordos anteriores.** Um item de `titulos_negociados`
  pode trazer `origem: "PARCELA_DE_ACORDO_ANTERIOR"` com
  `acordoOrigemMannesoft`, mas só quando a própria tela do Mannesoft
  distinguir esse título de uma mensalidade original. Sem essa distinção
  explícita, o item fica `INDETERMINADA` — nunca classificado por adivinhação.
- **Negociações mistas (mensalidade + parcela de acordo anterior na mesma
  composição).** `temComposicaoMista()`/`analisarComposicao()` só marcam
  composição mista quando a própria captura rotula origens diferentes dentro
  do mesmo grupo de títulos negociados; `INDETERMINADA` nunca conta nem como
  mista nem como pura.

## Reconhecimento automático no staging × bloqueio financeiro (terceira etapa)

A terceira rodada separou, de forma permanente, duas decisões que antes
estavam misturadas:

1. **RECONHECIMENTO** (`avaliarReconhecimento()`/`reconhecerCaptura()`) — só
   decide se a identidade, a composição e o histórico da captura podem ser
   **registrados no staging** sem conferência humana. Isto nunca autoriza
   nenhuma escrita financeira.
2. **BLOQUEIO FINANCEIRO** (`bloqueioFinanceiroAtivo()`) — decide se alguma
   rotina oficial poderia ser acionada a partir do que está no staging. Nesta
   etapa, **nunca libera**, para nenhuma situação, independente do
   reconhecimento: cancelamento, quitação, baixa e alteração de título
   continuam bloqueados até validação das rotinas oficiais e autorização
   específica de gestão.

Com essa separação, o padrão de reconhecimento deixou de ser "qualquer
cenário de renegociação cai em exceção" e passou a ser **automático por
padrão**, com conferência reservada só para quando houver:

- **(a) identidade ambígua** — colisão de chave dentro do lote
  (`COLISAO_CHAVE_NO_LOTE`), ou referência explícita a um acordo anterior que
  o staging não consegue resolver (`IDENTIDADE_AMBIGUA_REFERENCIA_NAO_RESOLVIDA`);
- **(b) composição divergente** — parcelas herdadas referenciando mais de um
  acordo de origem distinto (`COMPOSICAO_DIVERGENTE_MULTIPLOS_ACORDOS_DE_ORIGEM`);
- **(c) informação insuficiente** — parcela herdada sem dizer de qual acordo
  vem (`INFORMACAO_INSUFICIENTE_ORIGEM_DO_TITULO_SEM_REFERENCIA`).

Sob esse critério, os seis cenários pedidos nesta rodada são reconhecidos
**automaticamente** no staging quando a captura é inequívoca:

1. acordo cancelado e refeito (`REACORDO_APOS_CANCELAMENTO`, com referência
   resolvida);
2. reacordos sucessivos (`montarCadeiaReacordo()`, cadeia resolvida elo a
   elo);
3. renegociação de uma ou várias parcelas de acordo anterior (origem e
   referência explícitas, sem divergência);
4. negociação mista de mensalidades com parcelas de acordo (composição mista
   bem resolvida, sem divergência nem referência faltando);
5. acordo parcialmente pago que passa por renegociação — o traço
   `renegociacaoDeAcordoParcialmentePago` (informado explicitamente pelo
   chamador, nunca inferido aqui) é só informativo e não força conferência por
   si só;
6. acordo de parcela única — `parcelaUnica` é derivado só da contagem de
   títulos gerados, nunca usado para presumir quitação; a regra de quitação
   observada (`ehQuitacaoObservada()`) é a mesma para qualquer quantidade de
   parcelas.

Fail-closed continua valendo — qualquer captura que caia em (a), (b) ou (c)
sempre vai para `acordos_prime_staging_criticas`, nunca é promovida por
omissão — mas o escopo do que exige conferência ficou mais estreito e
explícito, exatamente como pedido nesta rodada.

## Vínculo com o convênio Santander ReATIVA — 272047/portador 166 (quarta etapa)

Diagnóstico desta rodada mostrou que nada no staging validava se a captura
realmente pertence ao convênio Santander ReATIVA (carrier `166`, covenant
`0272047` — medido em produção, ver `prime-mapa-identificadores.md`). A
quarta etapa fecha essa lacuna, com a mesma lógica fail-closed das demais:

- **Onde a evidência mora.** `avaliarVinculoConvenioReativa()` olha **só os
  títulos GERADOS do próprio acordo** (os boletos novos) — nunca a filiação
  geral do aluno ao portador 166 em outro lugar do CRM/Prime. Um aluno pode
  ter outros acordos ou mensalidades em qualquer portador; isso não prova
  nada sobre **este** acordo.
- **Sem lista rígida de portadores de ORIGEM.** Um título negociado
  (mensalidade original ou parcela herdada de acordo anterior) pode vir de
  qualquer portador — 195 (mensalidade em cobrança), 166, ou qualquer outro
  — e isso nunca é filtrado, restringido nem usado para excluir a
  negociação. `TituloNegociado`/`TituloGerado` só preservam
  `portadorIdMannesoft`/`convenioMannesoft` como o Mannesoft informar, brutos
  (ver `IdentificacaoPortador`).
- **Reconhecimento exige evidência no destino.** `ehPortadorReativa()` só
  reconhece um título gerado como ReATIVA quando ele próprio informa,
  explicitamente, portador `166` e/ou convênio `272047` (com ou sem zero à
  esquerda). Sem nenhum título gerado, ou com algum título gerado sem
  portador/convênio informado, o vínculo é **informação insuficiente**
  (`VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO`). Com algum título gerado
  apontando outro portador/convênio (ex.: 95/272036, 160/272037 — ambos
  "fora do escopo Reativa" por decisão da gestão, ou 165/202, judiciais), o
  vínculo é **divergência** (`VINCULO_CONVENIO_REATIVA_DIVERGENTE`). Os dois
  casos vão para `acordos_prime_staging_criticas`, nunca descartados — ficam
  registrados no staging, à espera de conferência.
- **Mudança de vínculo entre versões.** `compararVersoes()` agora também
  reporta `vinculoConvenioMudou` — se a captura passou de evidência
  suficiente para insuficiente/divergente (ou vice-versa) entre duas
  capturas do mesmo acordo — como sinal independente de `carteiraMudou`
  (que continua sendo o atributo livre, de compatibilidade, do acordo
  inteiro).

Nenhuma dessas checagens altera a separação reconhecimento × bloqueio
financeiro da etapa anterior: `bloqueioFinanceiroAtivo()` continua sempre
bloqueada, para todo caso, mesmo quando o vínculo com o convênio ReATIVA é
comprovado.

## PARCIAL — identidade/vínculo comprovados, composição completa desconhecida (quinta etapa)

Identidade do acordo e vínculo com o convênio ReATIVA são decisões
**diferentes** de composição financeira completa (quais títulos foram
negociados). Isso importa porque existe uma origem legítima de captura que
só comprova as duas primeiras, nunca a terceira: um **pagamento observado**
(boleto identificável, com o número do acordo decodificado pelo padrão já
comprovado; o convênio 272047, quando comprovável, viria do próprio campo de
convênio da linha do arquivo bancário de origem — nunca do formato do
boleto isoladamente). Um pagamento isolado nunca traz os títulos negociados
originais.

> **Correção (sexta etapa):** a frase acima presumia que o campo de convênio
> da linha bancária **já chegava e já era gravado** em `pagamentos`. Essa
> premissa estava **errada**: o campo era lido do arquivo por
> `normalizarLinhaSantander()`
> (`supabase/functions/santander-previa/planilha.ts`) e **descartado** na
> desestruturação; não era persistido, nem como coluna, nem dentro de
> `pagamentos.dados` (confirmado por `jsonb_object_keys(dados)`: 26 chaves
> observadas, nenhuma "convenio").
>
> **Correção (sétima etapa) — o estado ATUAL desta branch:** a sétima etapa
> alterou os dois normalizadores para **preservar** a coluna F em
> `convenio_bancario`, bruto, sem normalizar e sem validar. O campo passa a
> existir em `LinhaNormalizada` e, porque
> `projecao_importar_pagamentos` grava `dados = v` (o objeto inteiro, sem
> lista fixa de campos), **passa a ser persistido em `pagamentos.dados`** —
> 27ª chave, da próxima importação em diante. Isso **altera o importador
> Santander**: `planilha.ts` é o parser que `santander-importar/index.ts`
> consome. Nenhuma migration, trigger, tabela ou RPC foi alterada, e
> pagamentos já importados **permanecem sem o campo, permanentemente** (o
> arquivo original não é preservado para reprocessamento).
>
> Consequências operacionais obrigatórias estão na seção **"Publicação
> coordenada e rollback"**, ao fim deste documento. Toda frase anterior que
> dizia que o importador não seria alterado, ou que o convênio nunca seria
> persistido, descreve o estado **até a sexta etapa** e não vale mais.

`avaliarReconhecimento()` por isso ganhou uma terceira classe,
`ClasseSeguranca: "PARCIAL"`, motivo `COMPOSICAO_COMPLETA_DESCONHECIDA_PENDENTE_COMPLEMENTACAO`,
disparada quando `tracos.composicaoCompletaDesconhecida` é verdadeiro
(nenhum título negociado informado) **e** nenhuma das checagens de
ambiguidade/divergência/informação insuficiente já existentes disparou
antes — ou seja, PARCIAL só existe depois que identidade e vínculo com o
convênio já foram comprovados sem ressalva.

PARCIAL não é EXCECAO: não é enviada para conferência humana a cada
captura — fica registrada no staging, pendente de complementação. PARCIAL
não é AUTOMATICO: nunca é tratada como reconhecimento completo. Em nenhum
dos dois casos há promoção financeira — `bloqueioFinanceiroAtivo()`
continua sempre bloqueada, para toda classe, sem excecão.

**O que PARCIAL nunca presume:** quitação, cancelamento, quantidade total
de parcelas (inclusive as ainda não pagas) ou vínculo com mensalidades
originais. Só descreve o que é conhecido (identidade, vínculo, o(s)
título(s) gerado(s) daquele pagamento) e o que falta (composição completa)
— nunca completa por inferência.

**O que NÃO gera captura alguma:** filiação ao portador 166 sem nenhum
número de acordo identificado. É sinal de nível ALUNO ("tem relação com o
convênio"), nunca identidade de acordo — `montarChaveAcordo()` recusa sem o
número do acordo, e nenhuma captura chega a existir a partir só da
filiação.

## Adaptador PAGAMENTOS Santander → staging de ACORDOS (sexta etapa)

Esta etapa prepara, de forma isolada, a transformação de pagamentos
Santander **já armazenados** em `pagamentos` em capturas do staging —
sem alterar o importador Santander, o motor de conciliação ou qualquer
tabela financeira, e sem aplicar a proposta de schema do staging.

**Contrato real verificado nesta rodada (não repetir):**

- `pagamentos` tem `id` (uuid), `cpf`, `titulo_numero`,
  `numero_parcela_completo`, `valor_pago`, `data_pagamento`,
  `tipo_pagamento`, `dados` (jsonb), entre outras. **Nenhuma delas guarda o
  convênio bancário da linha de origem** — ver correção acima.
- `acordos` e `parcelas` também não têm nenhuma coluna de
  portador/convênio (`information_schema.columns`, consultado nesta
  rodada). Não há, portanto, nenhum caminho indireto já armazenado (nem
  mesmo via vínculo `parcelas.acordo_id`) que prove convênio por linha.
- `tipo_pagamento = 'SANTANDER'` identifica **o importador usado**, não o
  convênio da linha — o próprio código do importador (`santander-importar`)
  não distingue convênio na ingestão; aceitaria, sem diferença, qualquer
  arquivo Santander se um dia fosse alimentado com um de outro convênio.
  Por isso **nunca** é tratado como prova de 272047.
- `numero_parcela_completo` é o identificador correto, único por parcela
  (o próprio código do importador documenta isso e avisa para nunca usar
  `titulo_numero` para dedup) — é o `documento` usado pelo adaptador.
- O evento de pagamento nunca é identificado por parcela/boleto — é
  identificado por `pagamentos.id` (uuid, estável, gerado na origem),
  porque vários pagamentos (parciais, reimportados) podem compartilhar a
  mesma parcela sem serem o mesmo evento.

**O que o adaptador faz** (`supabase/functions/_shared/santander-pagamentos-acordos-adapter.ts`):

1. Decodifica identidade (número do acordo + parcela) do
   `numero_parcela_completo`, com validação de formato (`5` + acordo(6) +
   parcela(4) = 11 dígitos) — nunca convênio, mesma separação já fechada na
   quarta etapa.
2. Resolve a identidade do aluno só a partir de um CPF completo (11
   dígitos) já armazenado — nunca presume CPF nem vínculo inexistente.
3. Usa `pagamentos.id` como chave estável do evento — nunca
   `parcelas.boleto`/`numero_parcela_completo` isolados.
4. Acumula títulos gerados do mesmo acordo entre pagamentos — de um mesmo
   lote ou de lotes sucessivos (via `capturasAnterioresPorChave`, fornecida
   pelo chamador) — sem nunca perder uma parcela já conhecida.
5. Preserva, bruto, `portadorIdMannesoft`/`convenioMannesoft` quando a
   entrada os informa (hoje, sempre ausentes pelo motivo acima) —
   reaproveita, sem duplicar, `avaliarVinculoConvenioReativa()`/
   `avaliarReconhecimento()` já existentes para a classificação final.
6. Nunca fixa `situacaoMannesoft` como quitação/cancelamento — usa o rótulo
   fixo `EM_ANDAMENTO_OBSERVADO_PAGAMENTO_SANTANDER`, nunca inferido.
7. É idempotente: eventos (`idPagamento`) já processados, informados pelo
   chamador via `eventosJaProcessados`, são sempre ignorados; devolve um
   cursor (`cursorUltimoIdPagamentoProcessado`) para o chamador persistir e
   retomar com segurança após qualquer interrupção.

**Resultado da classificação real, hoje:** como nenhum dado já armazenado
comprova convênio, toda captura produzida pelo adaptador cai, pela lógica
já existente (`avaliarReconhecimento()`, inalterada), em
`EXCECAO`/`VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO` — nunca em `PARCIAL`
nem em `AUTOMATICO`. Isso é o comportamento fail-closed correto e já
comprovado; **não é um defeito do adaptador**, é o reflexo honesto de uma
lacuna real de dados. O adaptador e sua classificação ficam prontos para o
dia em que essa lacuna for resolvida (ex.: alteração do importador Santander
para reter o convênio — fora do escopo desta tarefa — ou outra fonte já
armazenada que venha a comprová-lo).

- `supabase/functions/_shared/santander-pagamentos-acordos-adapter.test.js`
  — 24 testes com dados fictícios: pagamentos parciais, boletos repetidos,
  acordos com várias parcelas, reimportações/idempotência e convênio
  divergente.

## O que esta etapa entrega

- `supabase/propostas/PROPOSTA_staging_acordos_prime.sql` — proposta de
  schema (não aplicada): `acordos_prime_staging` (histórico append-only por
  chave de acordo), `acordos_prime_staging_criticas` (exceções próprias,
  nunca a tabela de crítica da importação de boletos) e a view
  `acordos_prime_staging_atual`.
- `supabase/functions/_shared/prime-acordos-staging.ts` — lógica pura
  (identidade, hash de composição, comparação de versões, classificação de
  caso, classificação de segurança fail-closed, transformação proposta para
  o formato de `importar_acordos()`). Sem rede, sem Supabase, sem RPC —
  mesmo padrão de `pdf.ts`.
- `supabase/functions/_shared/prime-acordos-staging.test.js` — testes com
  dados fictícios cobrindo as 7 decisões acima.

Nada nesta entrega lê ou escreve em `acordos`, `acordos_titulos`, `parcelas`
ou `baixas_pagamento`. O motor de conciliação, as baixas e os valores
financeiros não são tocados.

**O importador Santander, porém, É alterado** — pela sétima etapa, que
preserva a coluna F nos dois normalizadores. Ver "Correção (sétima etapa)"
acima e "Publicação coordenada e rollback" abaixo.

## Dependências que ainda impedem a sincronização automática completa

| Dependência | Por que bloqueia | Quem decide |
|---|---|---|
| **Autorização para automatizar a extração das páginas do Mannesoft** | Sem ela não há captura real nenhuma para alimentar o staging — é a Etapa 0 de todas as rodadas anteriores. Não solicitada aqui. | Gestão/TI |
| **Validação da identidade na primeira captura real** | A unicidade do número do acordo do Mannesoft só é verificável com dado real; hoje nenhuma coluna do CRM guarda esse valor para cruzamento. O autodetector de colisão (índice `idx_acordos_prime_staging_colisao_lote`) está pronto, mas não testado contra captura real. | Primeira execução supervisionada |
| **Validação do formato aceito por `importar_acordos()`** | `transformarParaImportarAcordos()` é proposta, não contrato comprovado — a função devolve `pendenciasValidacao` a cada chamada listando o que falta confirmar (encoding de `acordo_base`, regra de CPF quitado, etc.). | Teste dirigido contra ambiente real, fora desta etapa |
| **Critério real de nível `FORTE`** em `acordo_vinculo_sugestoes_calcular()` | Não foi inspecionado nesta rodada se a composição vinda do Prime algum dia se qualifica como `FORTE` sob essa lógica, ou se cairá sempre em conferência manual. | Leitura da rotina real, antes de depender dela em produção |
| **Decisão de gestão sobre quitação observada externamente** | Não existe hoje rotina oficial que signifique "aplicar um status só observado externamente, sem fabricar um evento local". Fica como alerta até essa decisão existir. | Gestão |
| **RLS/grants do staging** | Esta proposta de schema deliberadamente não inclui RLS — precisa passar pela skill `seguranca-rls` antes de qualquer aplicação real. | Revisão de segurança, antes de aplicar a migration |
| **Identidade de serviço autorizada** para acionar as rotinas oficiais (`importar_acordos`, `cancelar_acordo_ficha`, etc.) a partir desta integração | Precisa de uma identidade formalmente autorizada por gestão (molde do `confirmacao-automatica@sistema` já em uso), não de um atalho que pule a checagem de permissão. | Gestão |
| **Equivalência entre a coluna F do arquivo Santander e o covenant do portador 166 no Prime** | A sétima etapa passou a preservar a coluna F, então o dado existe a partir da próxima importação. Mas a afirmação "coluna F do arquivo bancário ≡ covenant `0272047` do portador 166 no Prime" **não está comprovada em nenhum arquivo versionado** — é premissa, não medição. Enquanto não for provada, nenhum chamador deve projetar `dados.convenio_bancario` em `convenioMannesoft`: isso carimbaria proveniência Mannesoft num dado de origem bancária. O campo é de origem **bancária** (arquivo Santander), não Mannesoft. | Gestão/TI, por conferência entre um lote real do arquivo e a listagem do portador 166 no Prime |
| **Pagamentos já importados nunca terão o convênio** | O arquivo original não é preservado para reprocessamento, então toda linha importada antes da sétima etapa fica permanentemente sem `convenio_bancario`. Captura do adaptador sobre pagamento histórico seguirá em `EXCECAO/VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO`. | Nenhuma decisão pendente — é limitação definitiva, registrada |

Nenhuma dessas dependências bloqueia o que já foi entregue nesta etapa —
ficam documentadas para a próxima decisão, sem impedir o resto do
desenvolvimento.

## Publicação coordenada e rollback

A sétima etapa altera `supabase/functions/santander-previa/planilha.ts`, que
é compartilhado por **duas Edge Functions com deploy separado**:

- `santander-previa` — lê e normaliza em modo prévia, não grava;
- `santander-importar` — importa em duas fases, com digital do conteúdo
  (importa o parser de `../santander-previa/planilha.ts`).

### Por que a publicação tem de ser conjunta

`textoParaDigital()` hasheia as chaves da linha **ordenadas por desenho**. Ao
acrescentar `convenio_bancario`, a digital do **mesmo arquivo** muda. As duas
funções comparam digitais entre si para garantir que a prévia conferida é o
mesmo arquivo que está sendo importado.

Publicar **uma sem a outra** faz as digitais discordarem e a importação do dia
ser **recusada por inteiro**. O comportamento é fail-closed — não corrompe
dado, não grava pela metade — mas **trava a gestão** até a segunda função
subir.

### Procedimento de publicação

1. Mesclar a PR (não publica nada por si — Edge Function não sobe por merge).
2. Publicar as duas funções **na mesma janela**, fora do horário de
   importação, sem operador importando:
   - `santander-previa`
   - `santander-importar`
3. Conferir numa prévia real que a linha normalizada traz
   `convenio_bancario`, e que prévia e importação concordam na digital.
4. Só então liberar a importação do dia para a gestão.

A tela (`src/pages/ProjecaoHoraHora.jsx`) sobe pelo deploy do front, que é
independente. O caminho legado da tela (`p_linhas: linhasPreview`) também
passa a mandar a 27ª chave — logo o front pode subir antes ou depois sem
travar nada, porque ele não compara digital com as funções.

### Rollback operacional

| O que | Como | O que NÃO volta |
|---|---|---|
| Código | Reverter o commit do convênio e **republicar as duas funções juntas**, pela mesma regra do item 2 acima | — |
| Digital | Volta sozinha ao valor anterior quando as duas funções estiverem na versão revertida | — |
| `pagamentos.dados` | **Nada a desfazer por migration** — nenhuma coluna, trigger ou RPC mudou | As linhas já importadas **mantêm** a 27ª chave `convenio_bancario`. Não há limpeza prevista, e não é necessária: nenhum consumidor enumera as chaves de `pagamentos.dados`, todos leem chave por nome |

Não existe rollback de banco porque não existe alteração de banco. O efeito
residual é uma chave extra em linhas já gravadas — inerte por desenho.
