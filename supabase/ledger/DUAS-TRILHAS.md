# Duas trilhas: executável × histórico

Medição de 12/09/2026 contra `supabase_migrations.schema_migrations` do projeto
`ahattpqrjmhkzsmnbdzs`. **Nenhuma migration foi aplicada ou reaplicada** para
produzir este documento.

> Este arquivo substitui `PARIDADE-REPO-PRODUCAO.md`. O nome anterior prometia
> uma paridade que a medição mostrou não existir.

## Qual projeto este checkout está linked

Conferido em leitura, sem executar `link`, `db push`, `db pull` ou
`migration repair`:

| | |
|---|---|
| **Projeto linked** | **`ahattpqrjmhkzsmnbdzs`** — a **PRODUÇÃO** |
| Onde o CLI guarda | `supabase/.temp/linked-project.json` — gravado pelo `supabase link` |
| Conteúdo do arquivo | `{"ref":"ahattpqrjmhkzsmnbdzs","name":"…","organization_id":"djadacgcrxjubjblrlos",…}` |
| `project_id` em `config.toml` | `edlzlfbstshojxrudwaa` — **não é o projeto remoto**; é o identificador do projeto local. Não serve como prova de destino |
| `supabase/.temp/project-ref` | não existe nesta versão do CLI |
| Versão do CLI | o binário **não está instalado** (`supabase` não está no PATH). `supabase/.temp/cli-latest` registra `v2.115.0`, marcado em 24/08/2026. Uma consulta `npx supabase --version` baixa e responde `2.117.0` — essa é a versão que o npx buscou agora, não uma versão instalada aqui |

**Consequência: um `supabase db push` neste checkout vai para a PRODUÇÃO.**
Não há proteção acidental por apontamento de staging — afirmar isso seria errado
e perigoso. Enquanto não houver baseline validada, `db push` não deve ser
executado neste checkout.

> Nota de rastreabilidade: `supabase/.temp/linked-project.json` e
> `supabase/.temp/cli-latest` **estão versionados no git**, e o repositório é
> público. O `ref` do projeto não é segredo (aparece em toda chamada de cliente,
> junto da chave publishable, que é pública por desenho) e o e-mail já consta na
> autoria dos commits. Ainda assim, vale decidir se `supabase/.temp/` deveria
> estar no `.gitignore` — é diretório de estado local do CLI, não de projeto.

## Os dois sentidos, com número

| Sentido | Resultado |
|---|---|
| versões de arquivo que existem no histórico de produção | **41** de 451 |
| versões de arquivo que **não** existem no histórico | **410** |
| versões aplicadas em produção que têm arquivo | **41** de 1.238 |
| versões aplicadas em produção **sem** arquivo | **1.197** |

Isto **não é drift zero**, e não é um PR de arquivos que resolve. É estrutural:

* produção tem **1.238** versões registradas, das quais **1.229 têm timestamp
  real** — aplicadas por `apply_migration`, que grava o SQL em
  `schema_migrations` e **não cria arquivo**;
* só **9** versões de produção terminam em `0000`, o padrão de arquivo enviado
  pelo CLI. Todas as 9 têm arquivo em `supabase/migrations/` (lote do WhatsApp de
  17–19/08 mais `rls_tabelas_backup` de 26/07);
* o repositório tem **360** versões terminando em `0000` e **91** com outros
  sufixos. Dessas 91, **32** existem em produção.

`supabase/migrations/` e o histórico de produção são dois registros quase
disjuntos. A pasta é **documentação da intenção**; o histórico executável de
produção vive em `schema_migrations`.

## O que isso significa na prática

* **`supabase db push` num ambiente novo NÃO reproduz produção.** Aplicaria as
  410 versões que só existem como arquivo e deixaria de fora as 1.197 que só
  existem no histórico.
* **`supabase db pull` destruiria a documentação:** traria o schema atual como
  uma migration única, sem o porquê de cada decisão.
* O que mantém rastreabilidade hoje são três coisas juntas: o SQL exato em
  `schema_migrations`, o `supabase/ledger/` com md5 confirmado, e as notas de
  cada rodada.

## A separação das duas trilhas

| | A — `supabase/migrations/` | B — `supabase/ledger/` |
|---|---|---|
| O que é | cadeia que um ambiente vazio pode replicar | o que de fato rodou em produção |
| Quem executa | `supabase db push` | **ninguém** |
| **Por que B é seguro** | — | **está fora de `supabase/migrations/`**, e `db push` só lê aquela pasta |
| Nome | `<14 dígitos>_<nome>.sql` | `<14 dígitos>__<nome>.sql` |
| Sobre o `__` | proibido pela nossa regra de CI | **convenção visual + regra nossa**; o CLI não o reconhece e ele não protege nada sozinho |
| Conteúdo | SQL idempotente e revisado, com comentário | byte a byte igual aos `statements` |
| Prova de igualdade | revisão humana | md5 no `INDICE.tsv` |

## Situação de `supabase/migrations/` nesta rodada

Os 18 SQL aplicados em 11–12/09 foram para o **ledger**. A pasta de migrations
**não recebeu nenhum deles**. O que permanece lá sem estar versionado são duas
migrations nunca aplicadas:

| Arquivo | Classificação | Por quê |
|---|---|---|
| `20260908200000_busca_cpf_ignora_pontuacao.sql` | **`LEGACY_NAO_APLICADA_REDUNDANTE`** | o corpo de `buscar_aluno` em produção tem md5 **idêntico** ao que o arquivo criaria: `745be76f6b91fa94531fd5eeb9a67332`. Aplicar seria no-op exato |
| `20260910250000_tabulacoes_alegacao.sql` | **`LEGACY_NAO_APLICADA_REDUNDANTE`** | constraint, coluna, as 4 tabulações, função e gatilho já existem. A função em produção é 139 bytes maior: normalizando comentários, os md5 batem (`3a7001e8cfd65daa559d5e9bf700fea4`). Aplicar seria regressão de comentário |

**Não aplicar. Não apagar agora.** As duas saem da trilha executável somente na
transição formal para a baseline — tirá-las agora alteraria o estado histórico do
repositório sem ganho.

## Higiene: 22 versões duplicadas

Dois ou mais arquivos com o mesmo timestamp de 14 dígitos. **Todas com conteúdo
diferente** — são migrations sem relação que receberam a mesma versão. **Nenhuma
das 22 está registrada em `schema_migrations`**, e os objetos de todas as
amostradas (9 de 9) estão vivos no banco.

| Versão | Arquivo A | Arquivo B |
|---|---|---|
| `20260731230000` | acordos_parcelas_backfill_e_causa_raiz | tv_leitura_anon_kiosk |
| `20260801170000` | concluir_confirmacao_saldo_zero | listar_confirmacoes_sem_valor_real |
| `20260804160000` | saude_carteira_mascara_segura | vinculo_mensalidade_situacao_pago_manual |
| `20260804170000` | quitar_encerrar_statement_timeout | saude_carteira_cpf_unico_por_aluno |
| `20260805000000` | ativar_rls_tabelas_backup_snapshot | dados_academicos_schema_e_rpc |
| `20260805130000` | calibragem_saldo_aluno_bloquear_exposicao | notif_link_vinculo_caso_link_id |
| `20260805300000` | fechamento_fidelizar_prime | quitar_encerrar_quita_acordo_e_bloqueia_em_dia |
| `20260805310000` | fechamento_fidelizar_prime_so_gestao | quitar_encerrar_zera_titulos_por_status |
| `20260806140000` | fila_baixas_alunos_com_saldo | sugestoes_validacao_operador |
| `20260806170000` | calibragem_base_somente_casos_operacionais | calibragem_simular_500_saldo |
| `20260807200000` | calibragem_executar_nivelamento | tv_snapshot_allowlist_operadores |
| `20260821240000` | backfill_data_ultimo_acionamento | buscar_aluno_por_telefone |
| `20260824210000` | proteger_prazo_fidelizacao_nivelamento | recalc_respeita_tabulacao_do_dia |
| `20260825140000` | **4 arquivos**: confirmacao_origem_divida · diretoria_sem_notificacao · relatorio_2026_1_voltar_junho · whatsapp_trava_3_abordagens_operador | |
| `20260826010000` | conferencia_prime_titulos_pagos | quitado_automatico_encerra_o_caso |
| `20260826020000` | prime_coleta_acelerada | titulo_acordo_id_alinhado_ao_vinculo |
| `20260826150000` | acordo_lancar_so_gestao_financeira | termo_desfazer_nao_apaga_ultimo_arquivo |
| `20260826200000` | aluno_volta_para_fila_quando_entra_divida_nova | parcela_replicar_honorario |
| `20260827160000` | a_entrar_mostra_ultimo_acionamento | a_entrar_ordem_estavel_para_paginar |
| `20260904150000` | mensagem_enviada_retorna_em_5_dias_uteis | termo_nao_sera_assinado_e_devolver_ao_operador |
| `20260908200000` | baixa_pelo_documento_respeita_vencimento | **busca_cpf_ignora_pontuacao** (nunca aplicada) |
| `20260911160000` | carteira_2026_1_efetividade_v1 | tv_destaque_semana_por_valor |

### Por que o risco é de replay, não de hoje

`supabase_migrations.schema_migrations` tem **`PRIMARY KEY (version)`** —
conferido no banco. Logo **dois arquivos com a mesma versão nunca podem ser os
dois registrados**. Num `db push`, o segundo ou é ignorado em silêncio ou aborta
por violação de chave. Em qualquer dos casos **uma das migrations do par não
roda, e ninguém é avisado**.

Hoje isso não causa nada: nenhuma das 22 está no histórico e os efeitos já estão
no banco. O risco aparece no minuto em que a trilha A passar a valer — e é por
isso que a baseline **não** reaproveita estes arquivos.

**Não renomear.** Renomear versão antiga criaria um terceiro registro divergente:
arquivo com versão que nunca existiu nem no repo nem em produção. As 22 serão
resolvidas pela aposentadoria da trilha legacy na transição para a baseline, não
por cirurgia individual em timestamps antigos.

## Como reconferir

```sql
select count(*) total,
       count(*) filter (where version like '%0000') enviadas_por_arquivo,
       count(*) filter (where version not like '%0000') aplicadas_por_mcp
  from supabase_migrations.schema_migrations;
```

```bash
ls supabase/migrations/*.sql | sed -E 's|.*/([0-9]{14}).*|\1|' | sort -u | wc -l
cat supabase/.temp/linked-project.json
```

## Por que a versão de produção nunca bate com o nome do arquivo

Medido em 06/10/2026, depois de o drift acontecer três vezes seguidas e render
três linhas de ledger (PRs #603, #611 e #614). A seção acima já separava
`enviadas_por_arquivo` de `aplicadas_por_mcp`; aqui está **por que** a segunda
coluna existe, com a causa provada em vez de inferida.

### Causa raiz: a API não tem campo de versão

O `apply_migration` do MCP chama a Management API da Supabase. Conferido no
OpenAPI oficial (`https://api.supabase.com/api/v1-json`) em 06/10/2026:

| rota | corpo aceito | obrigatório |
|---|---|---|
| `POST /v1/projects/{ref}/database/migrations` | `query`, `name`, `rollback` | `query` |
| `PUT /v1/projects/{ref}/database/migrations` | `query`, `name`, `rollback` | `query` |
| `PATCH /v1/projects/{ref}/database/migrations/{version}` | `name`, `rollback` | — |

**Nenhuma das três aceita `version`.** O servidor atribui a versão a partir do
relógio dele no instante da chamada, e o nome do arquivo nunca é transmitido: o
`name` do corpo é texto livre e vai para `schema_migrations.name`, não para a
versão. O `PATCH` consegue mudar `name` e `rollback` de uma versão já registrada
— **não a versão**, e não executa SQL.

Logo o drift **não é descuido de quem aplica: é estrutural do caminho de
aplicação.** Duas confirmações de 06/10, com a versão igual ao horário UTC da
chamada, ao segundo:

| arquivo no repo | versão em produção | PR |
|---|---|---|
| `20261005204500_carteira_safra_situacoes` | `20261006094254` | #604, ledger #611 |
| `20261006120000_carteira_2026_1_indicadores_ao_vivo` | `20261006123312` | #612, ledger #614 |

Nos dois o md5 dos `statements` é idêntico ao do arquivo sem o newline final —
**o conteúdo nunca foi o problema, só o número.**

### O único caminho que preserva a versão

Das 1.518 versões registradas, **9 terminam em `0000`** e todas as 9 têm arquivo
em `supabase/migrations/` com o mesmo número: o lote do WhatsApp de 17–19/08 mais
`rls_tabelas_backup` de 26/07. Duas delas têm `created_by` e `statements` nulos;
as outras sete têm os dois preenchidos — CLI de versões diferentes.

Como a API não tem campo de versão, essas nove **não** passaram por ela. Elas
vieram de `supabase db push`, que conecta direto no Postgres e faz o `insert` em
`supabase_migrations.schema_migrations` por conta própria, com a versão que o
arquivo traz. **Preservar a versão exige escrever a linha do histórico à mão** —
é isso que o `push` faz por baixo.

### A regra que manda, antes de qualquer fluxo

> **Produção nunca pode receber antecipadamente uma migration que torne a `main`
> vigente incompatível.**

Tudo abaixo é subordinado a isso. Eliminar o drift é desejável; **nunca** ao
preço de deixar o banco à frente do código que está no ar. Em dúvida sobre qual
fluxo se aplica, é o fluxo seguro — a dúvida já é a resposta.

### Fluxo A — sem drift (exceção, não padrão)

**Permitido somente quando TODAS as condições valem:**

* DDL **retrocompatível**: o código hoje em produção continua funcionando com o
  banco depois da aplicação;
* **isolada**: não depende de outra migration nem de ordem com nada;
* **zero DML** — nenhum `insert`, `update`, `delete`, `truncate` de nível
  superior;
* **nenhuma alteração destrutiva**: sem `drop` de tabela, coluna, constraint ou
  índice em uso, sem estreitar tipo, sem revogar permissão de quem usa hoje;
* **não altera contrato nem assinatura**: nenhuma função ganha, perde ou troca
  parâmetro, tipo de retorno ou chave de retorno que algum consumidor já leia;
* **não depende de código ainda não publicado**: nada do que a migration cria
  precisa de front ou back que não esteja em produção.

Falhando **uma** dessas, é Fluxo B. Função nova, usada só por código que ainda
vai subir, é o caso típico de A — o banco ganha um objeto que ninguém chama
ainda, e nada existente muda de forma.

**Passos, na ordem:**

1. escrever a migration e abrir o PR normalmente;
2. **todos os checks verdes** e **autorização explícita da gestão** para aplicar
   antes do merge — não se presume, se pede;
3. conferir em leitura que a versão não existe e que o md5 do texto exato a
   enviar bate com o arquivo;
4. aplicar por `apply_migration`, **uma única vez**;
5. capturar a versão atribuída:
   `select version from supabase_migrations.schema_migrations where name = '<name>'`;
6. renomear o arquivo para esse número, mantendo o mesmo `name`, e empurrar;
7. conferir que o md5 do arquivo renomeado segue idêntico ao dos `statements`;
8. **rodada completa de CI de novo**, no SHA renomeado — o passo 6 muda o
   conteúdo do PR, e o verde do passo 2 não vale mais;
9. mesclar.

Resultado: repo e `schema_migrations` com a **mesma versão**, e nenhuma linha de
ledger de drift.

**Por que renomear aqui não contradiz o “Não renomear” da seção das 22
duplicadas.** Lá o alvo são versões **antigas, já no histórico do repositório**:
renomear criaria um terceiro número que nunca existiu nem no repo nem em
produção. Aqui o arquivo **ainda não está em `main`** — para o git é arquivo novo
adicionado já com o nome final, e a catraca `I3-MIGRATION-RENOMEADA` só dispara
em arquivo que **já existia no branch base**. São casos opostos.

**O custo:** entre o passo 4 e o passo 9 o banco está à frente do código no ar.
É justamente por isso que A exige retrocompatibilidade — nessa janela a `main`
vigente tem de continuar funcionando sozinha.

### Fluxo B — seguro, e é o padrão

**Obrigatório** sempre que houver qualquer um:

* **DML** — dado de produção sendo escrito, corrigido ou apagado;
* **mudança destrutiva** — `drop`, estreitamento de tipo, revogação de
  permissão em uso;
* **alteração de contrato ou assinatura** — parâmetro, tipo de retorno ou chave
  de retorno que algum consumidor já lê;
* **dependência simultânea de frontend e backend** — a migration só faz sentido
  com código que ainda não está publicado, ou o código novo só funciona com a
  migration.

**Passos, na ordem:**

1. escrever a migration e abrir o PR normalmente;
2. checks verdes;
3. **mesclar**;
4. **esperar o deploy de produção ficar `READY`**;
5. aplicar por `apply_migration`, uma única vez, **aceitando o timestamp que o
   mecanismo gerar** — não tentar forçar o número;
6. validar em leitura: registro único, md5 igual ao arquivo, objetos criados,
   invariantes do domínio;
7. **registrar o drift no ledger**, em PR próprio, nos termos de #611 e #614.

A linha de ledger aqui **não é dívida**: é o preço declarado de manter o código
no ar sempre compatível com o banco. Entre perder a igualdade de número e
arriscar incompatibilidade em produção, perde-se o número.

### Como escolher, em uma pergunta

> Se esta migration entrar agora e o merge **não** acontecer, a `main` que está
> no ar continua funcionando?

**Sim** e as outras condições de A valem → Fluxo A, com autorização.
**Não**, ou qualquer dúvida → Fluxo B.

### Continua vetado, nos dois fluxos

`supabase db push` · `supabase db pull` · `supabase migration repair` ·
**escrita manual em `supabase_migrations.schema_migrations`**.

O `insert` à mão preservaria a versão e a ordem “mesclar depois aplicar”, e foi
considerado — mas escreve o histórico fora de qualquer ferramenta, e forma errada
na linha quebra o CLI depois. Fica vetado junto com os três comandos.

### Opções descartadas, e por quê

| opção | por que não |
|---|---|
| passar a versão na API | **impossível**: nenhuma das três rotas aceita `version` |
| `supabase db push` | preserva a versão, mas é vetado — o checkout está linked na **produção** e o binário não está instalado (`supabase` fora do PATH, conferido em 06/10) |
| `migration repair` | vetado; e não executa SQL, só marca versão |
| `PATCH` na versão registrada | muda `name` e `rollback`, **não a versão** |
| `insert` na mão em `schema_migrations` junto do DDL | vetado — escreve o histórico fora de ferramenta; forma errada quebra o CLI depois |
| Fluxo A como regra universal | **recusado**: deixaria o banco à frente do código no ar também em migration destrutiva, com DML ou que muda contrato |
| seguir só com B, sempre | aceitável e seguro; custa uma linha de ledger por migration. A existe para o caso em que esse custo não se justifica |

### Como validar que a próxima nasce com o mesmo número (Fluxo A)

Depois do passo 6, antes de mesclar:

```bash
V=$(ls supabase/migrations/*_<name>.sql | sed -E 's|.*/([0-9]{14}).*|\1|')
echo "versao do arquivo: $V"
perl -0pe 's/\n\z//' supabase/migrations/${V}_<name>.sql | md5 -q
```

```sql
select version, name, md5(array_to_string(statements, E'\n')) as md5_prod
  from supabase_migrations.schema_migrations where name = '<name>';
```

Os dois `version` iguais e os dois md5 iguais: sem drift, e **nenhuma linha de
ledger a escrever**. Qualquer divergência: para e registra, como em #611 e #614.

No Fluxo B a validação é a mesma **menos** a igualdade de `version` — ali o
número divergente é esperado, e é ele que vai para o ledger.
