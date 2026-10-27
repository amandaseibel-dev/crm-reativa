# Relatório de segurança — P0 revogação de EXECUTE de PUBLIC/anon

**Resultado: 5/5 revogados e validados.**

| | |
|---|---|
| Data | 27/10/2026 |
| Ambiente | produção, `ahattpqrjmhkzsmnbdzs` |
| Executor | sessão principal de segurança, executora única |
| Autorização | expressa da gestão, para exclusivamente os cinco `revoke` |
| Pré-condição conferida | **12:24:26** (America/Sao_Paulo) |
| Execução | entre 12:24:26 e 12:25:06, transação única |
| Sondas pós-execução | **12:25:06** (−03) |
| Pacote aprovado | `docs/P0-REVOKE-EXECUTE-PUBLIC-ENCERRAMENTO.md`, seções A–F |

## 1. Pré-condição, imediatamente antes

| Verificação | Esperado | Medido |
|---|---|---|
| assinaturas encontradas | 5 | **5** |
| com PUBLIC tendo EXECUTE | 5 | **5** |
| com `authenticated` | 5 | **5** |
| com `service_role` | 5 | **5** |
| com concessão **direta** a `anon` | 0 | **0** |
| com exatamente 4 linhas de ACL | 5 | **5** |

Idêntico ao pacote aprovado. Nenhuma divergência, portanto nenhuma interrupção.

## 2. Execução

Transação única, cinco `revoke execute … from public, anon`, sem `grant`, sem
tocar outra função, sem alterar privilégio padrão. Sem erro.

```sql
begin;
revoke execute on function public._caso_sem_saldo_conferido(uuid, text) from public, anon;
revoke execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text) from public, anon;
revoke execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text) from public, anon;
revoke execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text) from public, anon;
revoke execute on function public.caso_encerramento_congelado(uuid) from public, anon;
commit;
```

## 3. ACLs — antes e depois, por `aclexplode`

**ANTES**, idêntico nas cinco (20 linhas, 4 por função):

| Papel | Privilégio | Concedente |
|---|---|---|
| **PUBLIC** | EXECUTE | postgres |
| postgres | EXECUTE | postgres |
| authenticated | EXECUTE | postgres |
| service_role | EXECUTE | postgres |

**DEPOIS**, idêntico nas cinco (15 linhas, 3 por função):

| Papel | Privilégio |
|---|---|
| postgres | EXECUTE |
| authenticated | EXECUTE |
| service_role | EXECUTE |

**PUBLIC desapareceu das cinco.** Nenhuma linha nova foi criada — em
particular, nenhuma concessão a `anon`, que nunca existiu de forma direta.

## 4. Privilégio efetivo depois

| Assinatura | `anon` | `authenticated` | `service_role` |
|---|---|---|---|
| `_caso_sem_saldo_conferido(uuid,text)` | **false** | true | true |
| `_caso_encerrado_operacional_regra(uuid,uuid,text×5)` | **false** | true | true |
| `_encerramento_congelado(uuid,uuid,text×5)` | **false** | true | true |
| `caso_encerrado_operacional(uuid,uuid,text×5)` | **false** | true | true |
| `caso_encerramento_congelado(uuid)` | **false** | true | true |
| `caso_encerrado_operacional(text×5)` — **não tocada** | false | **true** | **true** |

A assinatura de 5 argumentos, que o gatilho de `casos`, as duas funções de
carteira e a view `vw_saude_carteira` usam, está **intacta**.

## 5. Sondas HTTP anônimas — antes e depois

Chave publicável, `p_aluno_id`/`p_caso_id` nulos, CPF `00000000000`. Esse CPF faz
`_cpf11` devolver nulo, então **nenhuma consulta a `alunos` ocorre**. Nenhum dado
real de aluno foi acessado em nenhum momento.

| Função | Antes | Depois |
|---|---|---|
| `_caso_sem_saldo_conferido` | 200, `false` | **401**, 42501 |
| `_caso_encerrado_operacional_regra` | 200, `false` | **401**, 42501 |
| `_encerramento_congelado` | 200, `false` | **401**, 42501 |
| `caso_encerrado_operacional` (7 args) | 200, `false` | **401**, 42501 |
| `caso_encerramento_congelado` | 200, `false` | **401**, 42501 |

A mensagem é `permission denied for function <nome>` — nomeia a **função**, não o
schema. Isso importa: 42501 também apareceria por falta de `USAGE` no schema, e a
mensagem distingue os dois casos. O erro é o certo, pelo motivo certo.

## 6. Prova funcional dos perfis autorizados

Em transação revertida, com `current_user` conferido para garantir que o
`SET ROLE` pegou de fato — sem isso o teste "passaria" por falha do próprio
`SET ROLE`:

- **`authenticated`** (`current_user` = `authenticated`): as cinco revogadas
  **mais** a de 5 argumentos responderam, nenhuma levantou erro.
- **`service_role`** (`current_user` = `service_role`): as cinco responderam,
  nenhuma levantou erro.

## 7. O que a correção fecha, e o que não

**Fecha:** o oráculo anônimo de situação financeira por CPF, e o contorno da
policy de RLS de `caso_encerramento_sem_saldo` por
`caso_encerramento_congelado(uuid)`.

**Não fecha, e segue registrado:**

- As três funções de encerramento **com** portão interno
  (`caso_encerramento_resolver`, `…_resolver_aluno`, `caso_encerramento_pendentes`)
  continuam com PUBLIC na ACL. O portão interno é a trava efetiva — é a primeira
  instrução executável nas três, e `anon` é recusado —, mas o grant amplo segue
  como porta aberta na frente dela. Fora do escopo autorizado.
- `prime_portador_snapshot_estado(integer,integer)`, `acordo_saldo_residual(uuid)`
  e as demais funções com PUBLIC: não investigadas, por determinação da gestão.
- **Enumeração já ocorrida é indetectável.** Não há log de chamada de função
  nesta base. Não se afirma que ocorreu; afirma-se que não é verificável. A
  janela de exposição vai da criação das funções (`20261026200000`, 26/10/2026)
  até **27/10/2026 12:25**.
- A **causa raiz permanece NÃO COMPROVADA**. O privilégio padrão de `postgres`
  em `public` **não** concede PUBLIC, então as cinco eram anomalia, e a
  proveniência do `=X` não é recuperável nem pelo repositório nem pelo banco.
  Agravado por não haver entrada no ledger para `20261026200000`.

## 8. Regularização pendente

1. **Ledger:** registrar esta alteração, declarando explicitamente que entrou
   **fora de migration**, com a data e hora reais da revogação
   (27/10/2026, 12:24–12:25, America/Sao_Paulo). Essa data é o fim da janela de
   exposição e é o dado que importa num incidente de dado pessoal.
2. **Migration versionada:** transformar as seções A e C do pacote em migration
   mais arquivo de rollback, pelo canal da Fase 2 com autorização nominal.
   Hoje barrado por `P3/migration`.
3. **Sem reaplicação:** `revoke` é idempotente, mas a migration deve ser
   registrada como já aplicada, ou ter corpo idempotente, **e o ledger tem de
   apontar o passo 1 como o momento em que o acesso foi fechado** — não a data
   da migration. Senão o registro mente sobre quando a exposição terminou.
4. **Catraca de CI**, com a especificação da seção 6b do pacote (casar por nome,
   limitação de sobrecarga declarada, isenção versionada, linha de base).

## 9. Fora deste escopo, por determinação da gestão

Nenhuma alteração de dado financeiro, nenhuma outra mudança de ACL, nenhuma
migration, backfill, merge ou deploy. Privilégio padrão do banco **não**
alterado.
