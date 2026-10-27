# 20261027152500 — revogação emergencial de EXECUTE de PUBLIC em cinco funções do encerramento

**Aplicada:** 2026-10-27 15:25:00 UTC · **Tipo:** `EXECUCAO_PONTUAL` · `arquivo = 20261027152500__revoke_execute_public_encerramento.sql`

Cinco `revoke execute on function … from public, anon`, numa única transação.
**Zero DML, zero DDL de corpo de função, zero alteração de privilégio padrão,
zero outra função tocada.** Nenhum dado financeiro, parcela, acordo, título,
saldo, baixa, status ou titularidade alterado.

## Esta linha NÃO é uma migration

Não existe registro em `supabase_migrations.schema_migrations` para a versão
`20261027152500`. Ela é **pseudo-versão**, derivada do horário UTC da execução,
e serve apenas para ordenar o ledger. O que a distingue é o tipo
`EXECUCAO_PONTUAL`.

Em consequência:

- `md5` e `bytes` referem-se ao **arquivo** guardado ao lado, não a `statements`
  de `schema_migrations`;
- **a consulta padrão de reconferência não se aplica** a esta linha. A
  reconferência correta é a de ACL, no fim desta nota.

## Por que existe

As cinco funções eram `SECURITY DEFINER`, **sem portão interno**, recebiam CPF
ou uuid por parâmetro, e tinham **PUBLIC com EXECUTE** — logo eram chamáveis por
`anon` pela API pública. Isso é um oráculo de situação financeira por CPF. No
caso de `caso_encerramento_congelado(uuid)`, é também contorno da policy de RLS
de `caso_encerramento_sem_saldo`, cuja tabela tem RLS ligada com `SELECT`
restrito a `usuario_e_gestao()`.

## Correspondência

| | |
|---|---|
| Arquivo com o SQL exato | `20261027152500__revoke_execute_public_encerramento.sql` |
| md5 · bytes do arquivo | `9b12ed43d8a865bbdba6bc91ba4e4666` · 575 |
| Versão em `schema_migrations` | **nenhuma** — aplicação fora de migration |
| Pacote aprovado | `docs/P0-REVOKE-EXECUTE-PUBLIC-ENCERRAMENTO.md`, seções A–F |
| Relatório de segurança | `docs/seguranca/RELATORIO-P0-REVOKE-ENCERRAMENTO-2026-10-27.md` |

## Integridade: o que foi provado, e como

**Pré-condição, conferida às 15:24:26 UTC, imediatamente antes:** 5 assinaturas
encontradas, 5 com PUBLIC, 5 com `authenticated`, 5 com `service_role`, **0 com
concessão direta a `anon`**, 5 com exatamente 4 linhas de ACL. Idêntico ao
pacote aprovado — nenhuma divergência, nenhuma interrupção.

**ACL antes e depois, por `aclexplode`:**

| Momento | Papéis com EXECUTE, idêntico nas cinco | Linhas |
|---|---|---|
| antes | PUBLIC, postgres, authenticated, service_role | 4 por função · 20 |
| depois | postgres, authenticated, service_role | 3 por função · 15 |

PUBLIC saiu das cinco e **nenhuma linha nova foi criada**.

**Alcançabilidade medida, não suposta:**

| Função | Antes | Depois |
|---|---|---|
| `_caso_sem_saldo_conferido` | HTTP 200, `false` | **401**, 42501 |
| `_caso_encerrado_operacional_regra` | HTTP 200, `false` | **401**, 42501 |
| `_encerramento_congelado` | HTTP 200, `false` | **401**, 42501 |
| `caso_encerrado_operacional` (7 args) | HTTP 200, `false` | **401**, 42501 |
| `caso_encerramento_congelado` | HTTP 200, `false` | **401**, 42501 |

A mensagem é `permission denied for function <nome>` — nomeia a **função**, não
o schema, o que distingue de falta de `USAGE`. Sondas com `p_aluno_id` e
`p_caso_id` nulos e CPF `00000000000`, que faz `_cpf11` devolver nulo:
**nenhuma consulta a `alunos` ocorreu** e nenhum dado real de aluno foi acessado.

**Perfis autorizados, em transação revertida com `current_user` conferido** —
sem essa conferência o teste passaria por falha do próprio `SET ROLE`:

- `authenticated`: as cinco **mais** a assinatura de 5 argumentos responderam;
- `service_role`: as cinco responderam.

Nenhuma levantou erro.

## O que a aplicação NÃO fez

A assinatura de 5 argumentos `caso_encerrado_operacional(text,text,text,text,text)`
**não foi tocada**, de propósito: é a que o gatilho
`casos_set_encerrado_operacional`, `preview_redistribuicao_casos`,
`resumo_carteira_operador` e a view `vw_saude_carteira` usam — os quatro únicos
chamadores **sem** `SECURITY DEFINER`. Os outros ~41 chamadores são
`SECURITY DEFINER` do owner e não dependem de PUBLIC. Chamadores externos no
app: nenhum (um comentário e dois rótulos de relatório).

Não havia concessão direta a `anon` em nenhuma das cinco. Por isso o rollback
concede **apenas a PUBLIC**: conceder a `anon` criaria privilégio que não
existia, e seria ampliar acesso em vez de restaurar.

## Janela de exposição

De **26/10/2026**, quando `20261026200000` criou as funções, até
**27/10/2026 15:25 UTC**.

**Enumeração já ocorrida é indetectável:** não há log de chamada de função nesta
base. Não se afirma que ocorreu; afirma-se que não é verificável.

## Causa raiz: NÃO COMPROVADA, e duas explicações retiradas

Duas teses minhas caíram por medição, e registro as duas retratações.

1. *"A trava era pretendida e saiu inconsistente"* — sem proveniência.
2. *"Houve omissão sistemática; função nova nasce com PUBLIC"* — **325 de 508**
   migrations que criam função **já revogam** de `public, anon`, então
   `20261026200000` é **desvio** de convenção, não norma. E o privilégio padrão
   vigente para `postgres` em `public` é
   `{postgres=X, authenticated=X, service_role=X}` — **sem PUBLIC e sem `anon`** —,
   confirmado por `casos_elegiveis_liberacao_fidelizacao()`, criada pela mesma
   migration **sem `grant` algum** e limpa.

Logo as cinco eram **anomalia**, e a proveniência do `=X` **não é recuperável**
nem pelo repositório nem pelo banco. Agravado por não haver entrada no ledger
para `20261026200000`.

### Risco futuro identificado

O privilégio padrão do papel **`supabase_admin`** em `public` concede
**`anon=X` explicitamente**. Função criada por aquele papel nasce chamável por
`anon` — e por concessão direta, então um `revoke … from public` **não a
fecharia**. Toda migration precisa revogar de `public, anon` explicitamente,
porque não se controla qual papel aplica.

## Imprecisão honesta deste registro

`data_utc` é aproximado em minutos: `track_commit_timestamp` está `off` neste
banco, então a hora exata do commit não é recuperável. O valor registrado está
dentro da janela medida, de **15:24:26 a 15:25:06 UTC**.

## Rollback

Cinco `grant execute … to public`, na seção C do pacote. **Não executado.**
Restaura o estado vulnerável, e só se justifica se algum chamador não previsto
quebrar.

Conferir ACL **por conjunto** com `aclexplode`, nunca comparando `proacl` como
texto: num `grant`, PUBLIC vai para o fim do array e o concedente passa a ser
quem executou — comparar string daria falso negativo.

## Pendências que esta versão não resolve

- **A migration versionada equivalente ainda não existe.** Quando existir, deve
  ser registrada como já aplicada ou ter corpo idempotente, e o ledger tem de
  continuar apontando **27/10/2026 15:25 UTC** como o momento em que o acesso
  foi fechado — não a data da migration. Essa data é o fim da janela de
  exposição.
- As três funções de encerramento **com** portão interno
  (`caso_encerramento_resolver`, `caso_encerramento_resolver_aluno`,
  `caso_encerramento_pendentes`) seguem com PUBLIC na ACL. O portão interno é a
  trava efetiva — primeira instrução executável nas três, `anon` recusado —,
  mas o grant amplo segue como porta aberta na frente dela.
- `prime_portador_snapshot_estado(integer,integer)` e
  `acordo_saldo_residual(uuid)`: não investigadas, por delimitação de escopo.
- Catraca de CI: especificada na seção 6b do pacote, não implementada.
- Privilégio padrão do banco: **não alterado**, por determinação da gestão.

## Reconferência do estado atual

```sql
select p.oid::regprocedure::text as assinatura,
       coalesce(nullif(a.grantee::regrole::text,'-'), 'PUBLIC') as papel,
       a.privilege_type as privilegio
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join lateral aclexplode(p.proacl) a on true
 where n.nspname = 'public'
   and p.proname in ('_caso_sem_saldo_conferido','_caso_encerrado_operacional_regra',
                     '_encerramento_congelado','caso_encerrado_operacional',
                     'caso_encerramento_congelado')
 order by 1, 2;
```

Esperado: **nenhuma linha com papel `PUBLIC`** nas cinco revogadas;
`authenticated` e `service_role` presentes em todas. A assinatura de 5
argumentos aparece nesta consulta por compartilhar o nome e **deve** seguir sem
PUBLIC também — ela já estava assim antes, e não foi tocada.
