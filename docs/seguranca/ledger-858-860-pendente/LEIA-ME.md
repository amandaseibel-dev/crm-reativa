# Ledger pendente — migrations 858/860, aplicadas em 11/11/2026

As duas migrations de privilégio **já rodaram em produção**. O que falta é só o
**registro no ledger**, e ele está **bloqueado por desenho**. Este diretório
guarda o pacote pronto, versionado, para que a conclusão seja um passo e não
uma reconstrução.

## O que já está feito

| Ordem | Arquivo autorizado | Version carimbada | Hora UTC |
|---|---|---|---|
| 1ª | `20261107200000_revoke_truncate_backup_pos_import` | `20261111153032` | 15:30:32 |
| 2ª | `20261108130000_acordos_pos_importacao_sem_truncate` | `20261111170705` | 17:07:05 |

Confirmado em produção, somente leitura: `authenticated` com `TRUNCATE` em
**0** das 548 tabelas `_backup_pos_import_*`; `service_role` preservado nas
548; RLS ligada nas 548 com 0 policy; `EXECUTE` da função inalterado. O
`status` das duas linhas em `docs/seguranca/migracoes-aprovadas.tsv` foi para
`aplicada`.

## Por que o ledger não foi escrito

O Guardião nega qualquer escrita em `supabase/ledger/**`, pelas duas vias:

- `R5/ledger` no Bash — `plugins/reativa-one/hooks/guardiao.sh:439`
- `P1/ledger` no Edit/Write — `plugins/reativa-one/hooks/guardiao.sh:731`

A alternativa que o próprio hook declara é **"nenhum — ledger não se edita"**.
A restrição **não foi contornada** — nem por worktree fora do projeto, que é
falha conhecida e registrada, não rota.

## Dois hashes diferentes, que não devem ser confundidos

| | Hash de **autorização** (M1) | Hash de **integridade** (ledger) |
|---|---|---|
| Algoritmo | `sha256` | `md5` |
| Sobre o quê | a string `query` enviada ao `apply_migration` | o arquivo `.sql` guardado no ledger |
| Serve para | provar que o que rodou **foi o que a gestão aprovou** | provar que o arquivo **é igual ao que produção guardou** |
| Onde mora | `docs/seguranca/migracoes-aprovadas.tsv`, campo 3 | `supabase/ledger/2026-11/INDICE.tsv`, campo 4 |
| Valores | `ea9c49a2…1fa56` / `d2d9cfdc…e9c8a` | `950affcd…cef73` / `4a87a131…0de7` |

São perguntas distintas. O primeiro já cumpriu o seu papel quando o portão
liberou a aplicação. O segundo é o que este pacote precisa fechar.

## A convenção efetiva do ledger, medida

A `LEIA-ME.md` de `supabase/ledger/` manda conferir com
`perl -0pe 's/\n\z//' arquivo | md5 -q`. **Isso não é a convenção efetiva** —
medido nos arquivos que existem:

| Version | `INDICE.tsv` casa com | `bytes` no índice | bytes do arquivo |
|---|---|---|---|
| `20260911204433` | md5 **sem** o newline | 1.080 | 1.081 |
| `20261106151254` | md5 **direto** | = arquivo | = arquivo |
| `20261108204402` | md5 **direto** | = arquivo | = arquivo |
| `20261108234022` | md5 **direto** | = arquivo | = arquivo |
| `20261111114543` | md5 **direto** | = arquivo | = arquivo |

O invariante que vale nos dois casos é outro, e é o da **regra 1** do
diretório: **`md5` e `bytes` descrevem os `statements` de produção.** Quando os
`statements` têm o newline final, o arquivo copiado cru já é igual a eles e o
`md5 -q` direto casa — os quatro casos de novembro. No caso de setembro os
`statements` não tinham o newline, o arquivo foi guardado com ele, e o índice
registrou o md5 e os bytes dos `statements`: o arquivo ficou **um byte
diferente** do que diz representar.

**Aqui não se repete isso.** Os `statements` destes dois não têm newline final,
então o arquivo é **criado sem ele** — fica byte a byte igual aos `statements`,
e a conferência é `md5 -q` **direto**, sem transformar nada na hora de medir.

## A ação mínima que falta

Quem tiver a escrita do ledger liberada executa **três passos**.

**1. Criar os dois `.sql` byte a byte iguais aos `statements`.** O `perl`
aparece aqui, na **criação**, porque é aqui que a diferença de um byte existe e
fica registrada — nunca na conferência:

```bash
cd /Users/amandapradoseibel/Documents/crm-reativa-atual && perl -0pe 's/\n\z//' supabase/aguardando_aprovacao/20261107200000_revoke_truncate_backup_pos_import.sql.pendente > supabase/ledger/2026-11/20261111153032__20261107200000_revoke_truncate_backup_pos_import.sql
```

```bash
cd /Users/amandapradoseibel/Documents/crm-reativa-atual && perl -0pe 's/\n\z//' supabase/aguardando_aprovacao/20261108130000_acordos_pos_importacao_sem_truncate.sql.pendente > supabase/ledger/2026-11/20261111170705__20261108130000_acordos_pos_importacao_sem_truncate.sql
```

**2. Acrescentar as duas linhas de `INDICE-linhas.tsv` (deste diretório) ao fim
de `supabase/ledger/2026-11/INDICE.tsv`.** São 9 campos separados por TAB:
`version · nome · arquivo · md5 · bytes · data_utc · tipo · revertida_por ·
nota`.

**3. Conferir — `md5 -q` direto, e o tamanho.** Sem remover nada:

```bash
cd /Users/amandapradoseibel/Documents/crm-reativa-atual && for v in 20261111153032:950affcd2d09891357ec3cdcbd7cef73:36840 20261111170705:4a87a131bde02e15e7713d88b7c70de7:8850; do f=$(ls supabase/ledger/2026-11/${v%%:*}__*.sql); r=${v#*:}; m=$(md5 -q "$f"); b=$(wc -c < "$f" | tr -d ' '); if [ "$m" = "${r%%:*}" ] && [ "$b" = "${r##*:}" ]; then echo "OK  ${v%%:*}  md5 $m  $b bytes"; else echo "DIVERGIU  ${v%%:*}  md5=$m bytes=$b"; fi; done
```

Os comandos dos passos 1 e 3 foram **executados e validados** em 12/11/2026
contra uma cópia fora do ledger: saíram 36.840 e 8.850 bytes, md5 `950affcd…` e
`4a87a131…`, batendo com produção.

## A diferença entre o arquivo-fonte e o SQL enviado

Registrada aqui em separado, porque é real e não deve ficar escondida dentro de
um comando de conferência.

| | Arquivo-fonte (`.pendente` em `origin/main`) | SQL enviado a produção |
|---|---|---|
| 858 | 36.841 bytes, termina em `0x0A` (blob `3fffbcc85656`) | 36.840 bytes, termina em `)` |
| 860 | 8.851 bytes, termina em `0x0A` (blob `f4c234ec64d4`) | 8.850 bytes, termina em `;` |

A diferença é de **um byte**, o `0x0A` final, e **nenhum outro** — o `sha256`
do conteúdo sem esse byte é idêntico ao que a autorização M1 carregava, o que
prova que o corpo é o mesmo.

**Por que o newline não foi enviado — correção de uma explicação errada que
este arquivo trazia antes.** O portão **não exige** remover nada. Ele preserva
os bytes exatos de `tool_input.query`, de propósito, com uma sentinela
(`guardiao.sh:271-272`):

```sh
# `$(...)` apagaria a quebra de linha final do SQL. A sentinela preserva os bytes.
q="$(printf '%s' "$PAYLOAD" | jq -j '.tool_input.query // empty'; printf x)"
q="${q%x}"
```

e hashea esses bytes como vieram (`guardiao.sh:278`). Então **o newline final
passa, se for enviado**.

O que obrigou a enviar sem ele foi **a linha de autorização**, que carregava o
`sha256` do conteúdo *sem* o newline — e o portão compara byte a byte. A
restrição veio do hash registrado, não do portão. Se a linha tivesse sido
emitida com o hash do arquivo inteiro, a `query` poderia ter sido o arquivo
verbatim e este `.sql` do ledger seria um `cp` simples.

**Consequência prática para as próximas:** as duas formas são legítimas; o que
não pode divergir é o hash da linha e os bytes enviados. Conferir qual das duas
a linha registrou **antes** de montar a chamada. Exemplo vivo: a linha M1 da
migration `20261109180000_ulbra_vinculo_leitura` (PR #918) registra o `sha256`
do arquivo **com** o newline final — ali a `query` tem de ser o arquivo
verbatim.

## Pendência para quem cuida do ledger

A `LEIA-ME.md` de `supabase/ledger/` e as notas das entradas de novembro dizem
coisas opostas sobre o `md5` — uma manda remover o newline, as outras mandam
usar o direto. As duas estão certas para os seus casos e erradas como regra
geral. O enunciado que cobre os dois é: **o arquivo deve ser byte a byte igual
aos `statements`, e o `md5`/`bytes` do índice são medidos direto no arquivo.**
Reconciliar aquele texto é alteração em `supabase/ledger/**` e, portanto,
também está fora do alcance desta sessão.
