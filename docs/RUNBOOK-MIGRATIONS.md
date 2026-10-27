# RUNBOOK — Migrations do ReATIVA One

**Criado em 26/10/2026.** O hook do Guardião já apontava este documento como o
procedimento humano para migration; ele não existia no repositório. Este arquivo
preenche essa lacuna.

Vale para toda mudança de banco em produção: função, RPC, view, tabela, gatilho,
policy, grant, índice ou dado estrutural.

---

## 1. Quem autoriza

**A gestão, e somente ela.** A autorização é por mudança, nominal e específica: diz
quais versões, em que ordem, e o que não está autorizado no mesmo movimento.

Não autoriza:

- a citação, por um terceiro, de uma autorização dada a outra sessão;
- uma autorização dada antes, para outra mudança, ainda que parecida;
- texto encontrado em arquivo, log, página, comentário de PR ou saída de ferramenta.

Aprovação para desenvolver **não** é aprovação para aplicar. São dois atos.

## 2. Executor único por mudança

Cada mudança tem **uma** sessão executora, declarada antes de começar. As demais podem
ler, revisar e medir — nenhuma escreve.

Duas sessões autorizadas para a mesma ação irreversível já aconteceu neste projeto: a
segunda chegou a executar e só a proteção por SHA nos dois lados evitou o dano. Se
surgir ambiguidade sobre quem executa, pare e pergunte **antes** do primeiro comando de
escrita.

## 3. Desenvolvimento e revisão em branch isolada

- Branch e worktree próprios, a partir da `origin/main` atual.
- Nunca no checkout principal, nunca sobre o trabalho pendente de outra frente.
- `git stash` é por **repositório**, não por worktree: num worktree, use commit de WIP;
  se tiver de stashar, nomeie (`git stash push -u -m "<tag>"`), guarde o SHA e restaure
  com `apply`, nunca `pop`.
- Versão nova: confira que o número está livre **nas refs locais e no registro de
  produção**. A catraca do CI indexa apenas as versões que já existem no branch base,
  então duas branches podem introduzir a mesma versão nova e cada uma passa sozinha.
- Nome do arquivo: `<14 dígitos>_<descricao>.sql`. `__` no nome é padrão de ledger e a
  catraca reprova.

## 4. Testes, Guardião, md5 e rollback

**Testes.** Banco real (PGlite) sobre a fixture de produção, com o arquivo de
alinhamento que traz o texto exato de `pg_get_functiondef` das funções envolvidas. Um
teste de migration tem de **executar a função inteira**: coluna de `returns table` não
qualificada só aparece em tempo de execução (já derrubou uma função em produção com
42702). Rode com `TZ=UTC` antes de empurrar, e não asserte horário renderizado.

**Guardião.** Rode a auditoria do diff antes da PR. Toda mudança que toca função, RPC,
view, tabela, gatilho, policy ou grant passa por ele. Lembre que grant de função nova
**não** segue os da view, e que tabela nova no schema `public` herda `arwdDxtm` para
`authenticated` — inclusive TRUNCATE, que a RLS não cobre.

**md5.** Toda substituição de função existente carrega guarda de `md5(prosrc)` medido em
produção, que interrompe a migration antes de qualquer `create or replace` se o texto
divergir. Onde não há rota de arquivo para o banco, essa guarda é o que prova que a
transcrição foi fiel. Prefira patch ancorado — ler `pg_get_functiondef` e trocar só o
trecho — a reescrever a função inteira.

**Rollback.** Escrito **junto** com a migration, não depois. PITR **não** está
habilitado neste projeto: rollback não é restore. Ele é backup dos registros afetados
mais SQL de reversão por id exato, que não apaga o que entrou depois. Rollback de função
restaura o texto exato anterior e **confere o md5 de volta**. Trilha de auditoria e
registros de congelamento são **preservados** pelo rollback.

## 5. Aprovação da PR e CI antes da implantação

- PR aberta, revisada e aprovada pela gestão.
- CI verde conferido **por nome de check**: "zero pendentes" não é "todos rodaram", e
  checks verdes podem ser de deploy, não dos testes. Confira cada job que importa.
- Se a base da PR for uma branch já mesclada, o CI pode não disparar — sintoma típico é
  um subconjunto dos checks aparecer.

## 6. Aplicação em produção somente com autorização específica

Aplicar exige autorização nova, posterior à aprovação da PR, nomeando as versões e a
ordem. Antes de **cada** aplicação, reconfirme as pré-condições — versões ainda não
aplicadas, md5 das funções-alvo, objetos ausentes/presentes. Divergência: **pare e
informe**, não contorne.

Aplique uma, valide o resultado, e somente então aplique a seguinte.

`apply_migration` grava a versão pelo **próprio relógio UTC** e ignora o número
pretendido no nome do arquivo. A ordem fica garantida pela sequência de aplicação, e a
divergência entre o número do arquivo e a versão registrada precisa ser informada.

Não acompanham a autorização de aplicar, a menos que ela diga: backfill, resolução de
congelamentos, liberação manual de alunos, alteração de cadastro ou qualquer outra
migration.

## 7. Registro da versão efetivamente aplicada no ledger

Registre no ledger a versão **que o banco gravou**, não a que o arquivo pretendia. A
entrada carrega os md5 e o tamanho dos statements; versão com migration vai com arquivo
`-`. O ledger é registro byte a byte do que rodou: um comentário nosso muda o md5, que é
a própria prova. Por isso ele **não se edita** — `R5/ledger` barra escrita por shell em
`supabase/ledger`, de propósito.

O ledger **não é portão**: a catraca não reprova por falta de linha. O registro é
obrigação de processo, não dependência técnica — e já houve versão aplicada em produção
sem registro por isso.

## 8. Diante de um bloqueio R5 ou P3

As duas regras cobrem o mesmo ato por caminhos diferentes: **`R5/migration`** barra
escrita por shell no diretório de migrations, **`P3/migration`** barra Edit/Write no
mesmo caminho. A justificativa é a mesma: "nesta fase nenhum agente escreve migration (o
agente de Banco é da Fase 2)".

Procedimento:

1. **Pare.** Não repita a chamada, não troque de ferramenta para o mesmo arquivo, não
   altere o hook, as permissões ou a configuração do plugin.
2. Use o caminho que o próprio hook autoriza: **propor o SQL no chat** e registrá-lo em
   documento sob `docs/`, com o rollback, o alcance medido e os invariantes.
3. Informe à gestão o código exato do bloqueio e o que ele impede em concreto — por
   exemplo: sem o arquivo em disco, o teste em PGlite também não roda, porque o harness
   lê a migration do disco.
4. Aguarde decisão. A gestão pode manter o bloqueio e seguir pelo documento, ou liberar
   nominalmente a gravação naquela branch.

Se o bloqueio casar por **texto citado** e não pelo destino — um documento em `docs/`
que cite o caminho protegido dentro de um exemplo —, reescreva a citação. Isso não é
contornar: nenhuma migration é escrita, e o destino nunca foi protegido. Diga o que
mudou e por quê.

---

## Dois registros que não podem se perder

**O agente de Banco da Fase 2 ainda não existe.** O `README.md`, o `CATALOGO.md` e o
`CHANGELOG.md` do plugin (v1.2.0) declaram que os agentes de Banco, Operacional,
Inteligência e Entrega são Fase 2 e não existem no pacote. A skill
`selecao-de-recursos` registra que a Fase 2 depende de autorização separada, sem nomear
quem a concede. Não há, hoje, a quem encaminhar o desenvolvimento de migration: não é
uma permissão a ligar, é um agente que ainda não foi escrito.

**Autorização da gestão não desativa automaticamente os bloqueios técnicos.** O hook não
tem variável de ambiente, flag ou configuração de fase: o bloqueio é incondicional por
caminho. Autorizar a mudança e destravar a ferramenta são coisas diferentes. Quando a
gestão autoriza algo que uma regra técnica ainda barra, o caminho é a própria gestão
gravar o arquivo ou liberar nominalmente aquela gravação — nunca o agente desarmar a
regra para cumprir a ordem.

---

## 9. Fase 2 de Banco — desenvolver migration sob autorização nominal

Implementada em 26/10/2026. Substitui o bloqueio total de desenvolvimento por um
portão estreito, **sem tocar nenhum bloqueio de aplicação**.

### O que ela libera, e só isso

`Write` e `Edit` de migration, no **worktree vinculado** e na **branch** que a gestão
nomeou. Nada mais.

- **A Fase 2 nunca libera escrita por shell**: `R5/migration` não consulta o portão, com a
  Fase 2 aberta ou fechada. Mas **"não libera" não é o mesmo que "barra sempre"**, e a
  versão anterior deste texto afirmava a segunda coisa, que é falsa. O `R5` casa padrões
  no **texto do comando**, então escapam dele, por desenho e não por defeito: caminho
  montado em variável (`V=migrations; echo x > supabase/$V/x.sql`), literal partido entre
  comandos (`cd supabase; cat > migrations/x.sql`), e escritores fora da sua lista de
  tokens (`python3 -c "open(...,'w')"`, `dd of=...`). O auditor contornou o `R5` dezenas
  de vezes assim, durante estas auditorias, para poder medir. **Token de escrita em caixa
  alta** (`CP`, `TEE`, `MV`, `SED -i`) escapava também, até a sétima auditoria: eles ficam
  no `if` **externo** do `R5`, e normalizar os ramos não serve enquanto o portão que leva
  até eles não estiver normalizado.
  O `R5` é quebra-molas, não cancela. **O portão de verdade é o de `Write`/`Edit`**, que
  resolve o caminho real e não depende do texto do comando.
- O destino tem de ser, pelo **caminho real resolvido**, a pasta de migrations daquele
  worktree. Subpasta, `..` que escapa e link simbólico apontando para fora são recusados.
- `main` e `master` são recusadas mesmo se nomeadas. O **checkout principal** é recusado
  mesmo se nomeado — a liberação exige worktree vinculado, detectado por o git-dir
  diferir do git-common-dir, sem caminho fixo no código.
- Nome com `__` segue reprovado (`P5`), porque é qualidade de nome e não permissão.

### Como autorizar, e por que não é arquivo

A autorização é a variável `REATIVA_FASE2_BANCO`, definida **no lançamento da sessão**,
com o valor `<raiz-do-worktree>|<branch>`.

Não é arquivo de propósito. O agente não escreve o ambiente do processo do hook — ele é
processo irmão, criado pelo harness, e estado de shell não atravessa chamadas de
ferramenta (medido: variável exportada numa chamada vem vazia na seguinte). Um arquivo no
repositório seria forjável: o detector de escrita por shell não cobre todo interpretador.

**Não coloque a variável em arquivo do repositório.** No bloco `env` do settings.json
versionado ela voltaria a ser forjável — por isso esse arquivo passou a ser protegido
contra agentes (`P2/permissoes-versionadas`), fechando um furo que existia antes: só o
caminho shell o protegia.

Como é por processo, **a autorização não acompanha outra sessão** e cai ao encerrar esta.
Para revogar antes: encerre a sessão. Executor único sai disso de graça.

### O que ela não muda

`apply_migration`, `db push`, `db reset`, `migration repair`, `migration up`, deploy,
merge, `git push`, `psql` de produção, escrita no ledger e nas permissões: **todos
seguem barrados**, com a Fase 2 aberta. São 12 casos do autoteste que provam isso
justamente com o portão aberto.

O portão é consultado em **um lugar só**, sobre escrita de arquivo. Nenhuma regra de
execução o chama. Aplicar migration continua exigindo autorização específica da gestão,
pelo procedimento das seções 6 e 7.

### Limite conhecido, registrado e não escondido

Nenhuma regra de caminho barra `Write`/`Edit` no **próprio arquivo do Guardião**. A
proteção hoje é a revisão do diff pela gestão — foi assim que esta própria mudança entrou.
Fechar isso exigiria decidir como a gestão autoriza uma alteração legítima do hook, e não
foi feito aqui.

O `R7/auto-desarme` cobre o caminho **shell**, e com as ressalvas do `R5` acima: ele casa
texto de comando. Duas vezes este documento afirmou que esse caminho estava barrado
quando não estava — primeiro por caixa no caminho (`HOOKS/`), depois por caixa no token
(`CP`, `RM`). As duas estão corrigidas e cobertas por teste; a lição é que a afirmação
sobre o `R7` vale **até o próximo caractere que ninguém normalizou**, e não é garantia
estrutural. A garantia estrutural de que o hook não é alterado continua sendo a sua
revisão do diff.

### Fase 2 não cria agente

O agente de Banco da Fase 2 continua não existindo, e o portão não depende dele: quem
desenvolve a migration é a sessão executora, sob autorização nominal, com o Guardião e
este runbook no lugar.

### O que a auditoria do Guardião derrubou, antes de isto entrar

A primeira versão deste portão foi **REPROVADA** pelo Guardião em 26/10/2026, com
defeitos reproduzidos — não hipóteses. Ficam registrados porque são a razão de o código
estar como está:

1. **O checkout principal era liberável quando nomeado.** No checkout principal o git
   devolve `--git-common-dir` **relativo** (`../../.git`), e resolvê-lo com `cd`
   interpretava o caminho contra o diretório do **processo do hook**, não contra o
   diretório do arquivo. Bastava o processo rodar de um lugar onde `../../.git` existisse
   para `git-dir != git-common-dir` passar espúrio. Corrigido com
   `rev-parse --path-format=absolute`. O teste antigo passava por acidente de diretório:
   agora o caso varia o diretório do processo de propósito (F29, F30).
2. **Valor malformado não era negado.** `${aut##*|}` pega o último campo, então
   `raiz|lixo|branch` passava com o campo do meio engolido em silêncio. A checagem
   mudou para o resto da cadeia (F31).
3. **A proteção que sustenta o portão não cobria caminho absoluto.** A regra das
   permissões só casava o settings versionado por caminho **relativo**: por caminho
   absoluto, ou visto de uma subpasta, a escrita escapava — e aquele arquivo tem bloco
   `env`, que é exatamente a porta de injeção da autorização. A mesma lacuna existia nas
   regras do ledger, do settings local, de `.git/` e do nome de migration, de antes
   desta mudança. Todas as cinco ganharam o par absoluto (F32–F37).
4. **`cd ""` devolve 0 em bash.** Toda saída de `git` passou a ser testada com `-n`
   antes de ser usada.

O limite declarado acima — `Write`/`Edit` no próprio arquivo do Guardião não é barrado
por regra de caminho — segue aberto e **não** foi corrigido aqui. Na Camada 0 ele está
em `ask`; o freio é a revisão do diff.

### Segunda reprovação: grafia equivalente de caminho

A auditoria seguinte confirmou os quatro defeitos acima corrigidos e **reprovou de novo**,
por um resíduo da mesma família. Os padrões das regras de caminho são literais e o `*`
do `case` come barra, então grafias equivalentes do mesmo arquivo escapavam de **todas**
elas — barra dupla ou `/./` no meio do caminho:

- o arquivo de permissões versionado, relativo e absoluto;
- o arquivo de permissões local;
- o ledger;
- a pasta de migrations — e esta **sem o portão ser consultado**, em qualquer checkout,
  inclusive o ligado à produção.

Isso refutava a frase "esse arquivo passou a ser protegido contra agentes", e com ela o
argumento que sustenta a autorização por ambiente: o bloco `env` do arquivo de permissões
versionado voltava a ser alcançável. A afirmação estava escrita aqui antes de ser
verdadeira.

Corrigido com `normalizar_caminho`, que colapsa barra dupla e `/./` e tira `./` inicial e
`/.` final **antes** de qualquer `case`, aplicada ao caminho e ao diretório corrente. A
normalização é **textual** de propósito: `rel` nasce de tirar o prefixo do diretório
corrente, e resolver link simbólico em só um dos dois lados tornaria todo caminho
absoluto, desarmando as regras relativas e o escopo declarado (`P6`). Quem resolve
caminho real é o portão, com `cd`/`pwd -P`, e essa parte já estava correta.

Duas armadilhas de bash foram medidas nessa correção, as duas no `/bin/bash` 3.2 do
macOS: em `${s//pat/repl}` o lado da substituição não é desescapado, então uma barra
invertida escrita ali entra literal; e aspas internas em `${s//"$pat"/"$rep"}` entram no
texto do resultado. A versão que funciona nas duas edições do bash usa variáveis sem
aspas, e os padrões de barra não têm caractere de glob.

Cobertura: casos F38–F45 do autoteste. Total: 120 casos, 120 como esperado.

### Terceira reprovação: `..` no meio e link simbólico

A normalização textual fechou barra dupla e `/./`, mas não resolve `..` nem link
simbólico — e os padrões das regras são literais. Escapavam de todas elas:

- `supabase/functions/../migrations/<arquivo>.sql` — **um passo, sem preparo**, em
  qualquer checkout, inclusive o ligado à produção, porque a pasta `functions` existe e o
  caminho resolve. O portão da Fase 2 não era nem consultado. O mesmo para o ledger;
- um **link simbólico** para a pasta de migrations: a escrita chega por caminho
  **canônico**, sem nenhuma grafia degenerada. E o `R5` deixava **criar** o link, porque
  exigia a barra final no padrão e `ln -s .../supabase/migrations <atalho>` nomeia a
  pasta, não um arquivo dentro dela.

Corrigido de duas formas:

1. As regras de negação passaram a ser avaliadas **duas vezes** — contra a forma textual
   normalizada e contra o **caminho real** (`cd "$(dirname)"; pwd -P`, o mesmo que o
   portão já fazia). Basta uma casar para negar. As duas formas são necessárias:
   resolver só a real tornaria o caminho absoluto quando um dos lados tem link, e as
   regras relativas e o escopo declarado (`P6`) deixariam de casar — por isso `P6`
   continua só na forma textual.
2. Os padrões de `R5` para migrations e ledger perderam a exigência de barra final, para
   que criar um atalho para a pasta seja barrado como escrever dentro dela.

Cobertura: casos F46–F53. Total: 128 casos, 128 como esperado.

**Padrão que estas três reprovações ensinam:** acrescentar padrão por padrão não fecha
uma classe de evasão de caminho. Só fecha quem **resolve o caminho** antes de decidir.
As duas primeiras correções foram sintomáticas e por isso cada auditoria achou a grafia
seguinte.

### Quarta reprovação: a segunda passagem falhava ABERTA

O defeito mais sério das quatro, porque contrariava a doutrina escrita no próprio hook —
*"região guardada: indeterminado = nega"*. A segunda passagem só corria quando o caminho
real resolvia; quando não resolvia, era **pulada em silêncio** e a escrita passava:

- **componente começando com `-`**: `dirname` e `basename` do macOS tratam o nome como
  opção, devolvem vazio, e `-x/../supabase/functions/../migrations/<arquivo>.sql` —
  relativo, com todos os componentes existentes, resolvendo de verdade para a pasta de
  migrations — **passava**. O preparo (`mkdir -- -y`) não é barrado por regra nenhuma;
- **pasta intermediária inexistente**: `supabase/zz/../migrations/<arquivo>.sql` passava
  porque a resolução falhava. O comentário do código afirmava "e aí não há escrita
  possível tampouco" — afirmação que eu **não havia provado**, e que a semântica do
  `mkdir -p` contradiz;
- **último componente não resolvido**: só o diretório era resolvido, então `Write` num
  link que aponta para o arquivo protegido escapava.

Corrigido assim:

1. `..` passou a ser colapsado **por segmento, no texto**, sem tocar o disco — não há
   como falhar, é string. Isto fecha as duas primeiras vias independentemente de o
   caminho existir;
2. `dirname --` e `basename --`, para a ferramenta não morrer com nome iniciado por `-`;
3. o último componente é seguido quando for link (até 10 níveis).

**Efeito colateral declarado, na direção de bloquear menos:** com o `..` resolvido, um
caminho que sai da pasta de migrations por `../..` e termina num arquivo comum passou a
**passar**, e isso é o resultado certo. Enquanto o `..` não era resolvido, isso negava
casando o glob no caminho não resolvido, ou seja, negava pelo motivo errado. É o único
ponto em que resolver o caminho bloqueia menos do que antes.

**Também declarado:** a fronteira do `R5` substituiu a tentativa anterior de simplesmente
tirar a barra final, que passou a barrar comandos de leitura legítimos sobre
`supabase/migrations_historicas_nao_comprovadas/` — pasta que não é protegida e existe no
repositório. Pelo princípio do próprio hook, "regra que incomoda sem motivo é regra que
alguém desliga".

**Limite que permanece:** um **hardlink** para arquivo protegido é indistinguível do
arquivo pelo caminho, e nenhuma destas regras o detecta. Criar um por shell é barrado
(`R5` pega `ln`); um hardlink pré-existente, não.

Cobertura: casos F54–F60. Total: 135 casos, 135 como esperado.

### Quinta reprovação: caixa, glob e a fronteira que eu errei duas vezes

Três achados, e o primeiro refuta a tese das quatro correções anteriores.

**1. O volume é case-insensitive.** Medido: `cd supabase/MIGRATIONS` abre a mesma pasta.
Os padrões das regras são literais e minúsculos, então um caminho com a caixa trocada
**grava dentro da pasta real e escapa de todas elas** — um passo, sem preparo, sem link,
sem `..`, em qualquer checkout, inclusive o de produção. A segunda passagem não salvava,
porque `pwd -P` **não canoniza caixa**: a forma real saía idêntica à textual e a
comparação que dispara a segunda passagem dava falso. Defeito pré-existente, e o mais
fácil de explorar de todos os cinco pareceres.

Corrigido casando as regras contra uma **cópia minúscula** do caminho, com os padrões já
minúsculos, e `grep -i` na parte de caminho do `R5`. A mensagem continua mostrando o
caminho original — quem lê precisa ver o que pediu, não a cópia. Num volume
case-**sensitive** uma pasta `supabase/MIGRATIONS` seria outra pasta e passaria a ser
barrada sem necessidade: é over-block na direção segura, de uma pasta que não existe no
repositório.

**2. O laço de segmentos expandia glob.** `for seg in $s` sem aspas faz word splitting
**e expansão de caminho**: `supabase/*/../migrations/<arquivo>.sql` virava
`supabase/aa/bb/migrations/<arquivo>.sql` e **o par protegido desaparecia do texto**.
Pior, o veredito passava a depender do **conteúdo do diretório do processo do hook** — com
o diretório vazio o glob não casava e o mesmo pedido era negado. Corrigido com `set -f`
em volta do laço, restaurando o estado anterior.

**3. A fronteira do `R5`, que eu errei nas duas tentativas.** Primeiro tirei a barra final
e passei a barrar leitura legítima na pasta homônima. Depois usei a lista
`($|[/ "'])`, e aí `cd supabase/migrations; cat > x.sql` escapava — troquei um colateral
por um furo, na porta que o desenho promete "sempre fechada". A classe certa é o
**complemento do nome**, `($|[^_A-Za-z0-9])`: o `_` fora dela preserva a pasta homônima, e
`;`, `>`, `|`, `&` entram.

Cobertura: casos F61–F72. Total: 147 casos, 147 como esperado.

### Sexta reprovação: caixa em mais três regras, e uma delas protegia o próprio hook

A correção de caixa da rodada anterior cobriu as regras de caminho e três ramos do `R5`, e
**deixou três checagens de fora** — as que ainda liam o comando em caixa original:

1. **`R7/auto-desarme`, a mais grave.** `plugins/reativa-one/HOOKS/guardiao.sh` é o mesmo
   arquivo neste volume, **inclusive no checkout de onde o plugin ativo é carregado**.
   Sobrescrever o hook derruba todas as regras de uma vez — `R1`, `R9`, `M1` incluídas. O
   desarme por shell, que a seção acima declarava barrado, estava aberto por uma letra
   maiúscula;
2. **`R5/git-interno`**: `.GIT/config` escapava pelo shell (o lado `Write`/`Edit` já
   negava);
3. **`R6/segredo-arquivo`**: `cat .ENV` escapava. Latente, porque o arquivo de ambiente
   não existe em nenhum dos checkouts — mas a regra não pode depender disso.

As três passaram a ler a cópia minúscula. E a isenção dos arquivos de exemplo teve de ir
para a mesma caixa: senão `.ENV.example` deixa de ser reconhecido como exemplo e passa a
ser barrado à toa — foi o que o caso F77 pegou, logo depois de eu corrigir as outras três.

Cobertura: casos F73–F77. Total: 152 casos, 152 como esperado.

**Padrão das seis reprovações, para quem vier depois:** nenhuma delas achou um erro de
lógica no portão. Todas acharam uma **grafia, uma caixa ou uma falha de resolução** que o
portão nunca viu. Freio que decide por comparação de texto precisa normalizar o texto
primeiro — e o inventário de normalizações é parte do freio, não um detalhe de
implementação.

### Sétima reprovação: o portão externo, em caixa original

A sexta rodada corrigiu a caixa do **caminho** em três regras. A sétima mostrou que isso
não bastava: o `if` **externo** do `R5` — a lista de tokens de escrita que habilita os
quatro ramos — e o segundo `grep` do `R7` continuavam lendo o comando em caixa original. E
`TEE`, `CP`, `MV`, `RM` e `SED` executam neste volume.

O efeito é instrutivo: o `-i` que eu havia posto nos ramos **nunca era consultado**,
porque o `if` que leva até eles não entrava. Passavam `CP` e `TEE` para dentro da pasta de
migrations, `MV` para dentro do ledger, `SED -i` numa migration, `CP` sobre o arquivo de
permissões — autoconcessão por shell — e, de novo, `CP` e `RM` sobre o arquivo do
Guardião.

**Normalizar o ramo não serve se o portão que leva até ele não estiver normalizado.** É a
mesma lição da rodada anterior, uma camada acima.

Cobertura: casos F78–F84. Total: 159 casos, 159 como esperado.
