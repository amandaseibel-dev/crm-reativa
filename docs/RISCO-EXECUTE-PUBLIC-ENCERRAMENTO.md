# Risco: a família do encerramento é executável por `anon`

**Registrado em:** 27/10/2026
**Estado:** **NÃO CORRIGIDO.** Exige autorização própria da gestão — a correção
é alteração em produção.

> **FONTE ÚNICA:** o preparo, o escopo e os critérios vivem em
> [`P0-REVOKE-EXECUTE-PUBLIC-ENCERRAMENTO.md`](P0-REVOKE-EXECUTE-PUBLIC-ENCERRAMENTO.md).
> Este arquivo é só o registro do achado. Onde divergirem, vale o P0.
**Severidade:** vazamento de dado pessoal financeiro. Não é caminho de escrita.
**Origem:** achado ao conferir a ACL para decidir se um `revoke` cabia no
rollback do CPF ambíguo. É falha da entrega `20261026200000`, não desta frente.

## O que foi medido em produção (27/10/2026)

```sql
select p.proname, p.proacl::text, p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute') as anon_executa
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in (...);
```

| Função | `security definer` | Portão interno | `anon` executa |
|---|---|---|---|
| `_caso_sem_saldo_conferido(uuid,text)` | sim | **não** | **sim** |
| `_caso_encerrado_operacional_regra(…7 args)` | sim | **não** | **sim** |
| `_encerramento_congelado(…7 args)` | sim | **não** | **sim** |
| `caso_encerrado_operacional(…7 args)` | sim | **não** | **sim** |
| `caso_encerrado_operacional(…5 args)` | sim | não | **não** |
| `caso_encerramento_resolver(…)` | sim | **sim** | sim, e é recusado |
| `caso_encerramento_resolver_aluno(…)` | sim | **sim** | sim, e é recusado |
| `caso_encerramento_pendentes(int)` | sim | **sim** | sim, e é recusado |
| `_cpf11(text)` | não | não | sim (inócua: normaliza texto) |

A ACL das expostas é `{=X/postgres,postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
O `=X` inicial é **PUBLIC com EXECUTE**, e PUBLIC alcança `anon`.
`has_schema_privilege('anon','public','usage')` também é verdadeiro.

## Por que importa

As quatro primeiras recebem **CPF por parâmetro**, são `SECURITY DEFINER` (rodam
com os privilégios do owner, atravessando RLS) e **não têm portão interno**.

Um chamador anônimo passa um CPF e recebe um booleano que diz se aquele CPF está
sem dívida. Com uma lista de CPFs — e CPF é enumerável —, isso é um **oráculo de
situação financeira por pessoa**. Dado pessoal financeiro, sem autenticação.

Fere a premissa de segurança do projeto em dois pontos: a regra de revogar
EXECUTE de `anon` e `public` por padrão, e a de não haver RPC com EXECUTE amplo
sem autorização interna.

## O que NÃO está exposto

As três funções que **escrevem ou listam** — os dois `resolver` e o
`pendentes` — **têm portão interno e levantam exceção**. `anon` as alcança e é
recusado. A liberação de congelamento, que é a ação sensível, **não está aberta**.
A assinatura de 5 argumentos de `caso_encerrado_operacional`, a mais usada
internamente, está fechada. **Por que ela está fechada e as outras não é
NÃO COMPROVADO** — eu afirmei antes que "a trava era pretendida e saiu aplicada
de forma inconsistente" e **retiro a afirmação**: não há proveniência disso nem
no repositório nem no banco. Ver a seção de causa raiz do P0.

## Alcance mais amplo, não investigado

`124` funções do schema `public` têm PUBLIC com EXECUTE nesta base. Muitas podem
ser legítimas. **Não auditei as outras** — este documento cobre só a família do
encerramento. Fica anotado como frente candidata.

## Correção mínima proposta (NÃO aplicada)

Uma declaração por função, sem mudança de comportamento:

O escopo são **CINCO** assinaturas, não quatro, e o SQL exato está no P0. A
quinta é `caso_encerramento_congelado(uuid)`, que contorna a policy de RLS de
`caso_encerramento_sem_saldo`.

`authenticated` e `service_role` permanecem. Nenhum chamador interno quebra: os
consumidores são `SECURITY DEFINER` do owner e não dependem de PUBLIC.

Conferir depois por **conjunto** (`aclexplode`), nunca comparando `proacl` como
texto — a ordem do array e o concedente não são estáveis. A consulta está no P0.

## Rollback da correção

```sql
grant execute on function public.<assinatura> to public;
```

Devolve o estado de 27/10/2026 — que é o estado vulnerável. Só faz sentido se a
revogação quebrar algum chamador não previsto.

## Por que não foi corrigido junto com o CPF ambíguo

Rollback e correção pontual não são lugar de consertar segurança de carona: a
mudança de ACL ficaria escondida num arquivo cujo objetivo declarado é outro, e
a conferência por MD5 **não enxerga ACL nenhuma**. Vai como frente própria, com
autorização própria e executor designado.
