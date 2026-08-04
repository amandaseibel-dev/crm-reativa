# PREMISSA DE SEGURANÇA, PRIVACIDADE E LGPD — CRM ReATIVA

> **Regra permanente do projeto.** Segurança e proteção de dados são requisitos
> **obrigatórios** de toda alteração. Nenhuma funcionalidade é "concluída" só por
> funcionar visualmente. Toda entrega precisa **provar** que não amplia acesso
> indevido, não expõe dados pessoais e não depende do frontend para autorização.
>
> Ambiente PROD: `ahattpqrjmhkzsmnbdzs` · Staging: `edlzlfbstshojxrudwaa`.
> O bundle de produção **nunca** pode referenciar o ref de staging nem a service_role.

---

## 1. Princípios obrigatórios

- Acesso mínimo necessário (least privilege).
- Negação por padrão (deny-by-default): RLS ligada + policies explícitas.
- Separação de perfis: gestão / administrativo / operador.
- Isolamento da carteira do operador.
- **Autorização no backend** (RLS + RPC), nunca só no frontend.
- Minimização e mascaramento de dados pessoais.
- Auditoria de ações sensíveis (financeiro, responsável, confirmação, baixa).
- Idempotência e transações atômicas.
- Nenhuma credencial no código; nenhuma autorização baseada só em dado enviado pelo frontend.

## 2. Matriz de perfis

| Perfil | Identidade (exemplos) | Pode |
|---|---|---|
| **anon** | sem JWT | **nada** de dados operacionais |
| **authenticated sem perfil** | usuário logado inativo/sem cadastro em `usuarios` | bloqueado por `app_usuario_ativo()` / `perfil_do_usuario_atual()` |
| **operador** | `cobrancaNN@aelbra.com.br` | apenas a **própria carteira** (casos/alunos/acordos/pagamentos onde é responsável) + pool sem dono; **não** confirma pagamento, **não** dá baixa, **não** troca responsável |
| **Amanda ADM** | `cobranca07@aelbra.com.br` | carteira ADM + gestão financeira conforme flags; **não** é gestão total de `usuarios` |
| **Fernanda** | `cobranca04@aelbra.com.br` | gestão conforme allowlist |
| **Amanda gestora** | `amanda.seibel@aelbra.com.br` | gestão total |

Autorização derivada **sempre** do JWT (`auth.email()` / `auth.jwt()`), via funções
`SECURITY DEFINER` com `search_path` fixo: `usuario_e_gestao()`, `usuario_e_gestao_fila()`,
`app_usuario_ativo()`, `perfil_do_usuario_atual()`, `app_email()`, `app_owns_acordo()`.
Flag específica: `usuarios.pode_gerir_confirmacao_pagamento` para confirmar pagamento.

## 3. Regras de RLS (tabelas)

Toda tabela nova nasce com:

1. `ENABLE ROW LEVEL SECURITY`.
2. Grants revisados (ver §5) — nunca ampliar além do necessário.
3. Policies mínimas e explícitas por comando (SELECT/INSERT/UPDATE/DELETE).
4. **Proibido** `USING (true)` / `WITH CHECK (true)` sem justificativa documentada aqui.
5. Se a leitura deve ser via RPC → **sem** policy de SELECT para operador (deny-all + RPC `SECURITY DEFINER`).
6. Auditoria quando houver dado sensível/financeiro.

**Tabela operacional com RLS desligada → publicação bloqueada.**
Tabelas internas de backup/snapshot: RLS ligada deny-all + **sem grant** a anon/authenticated.

## 4. Padrão de RPC / função

Toda função `SECURITY DEFINER` deve ter:

- `SET search_path = public` (fixo) — **reconfirmar após todo `CREATE OR REPLACE`**.
- Proprietário adequado (`postgres`).
- **Autorização interna** no início do corpo (checar `perfil_do_usuario_atual()` /
  `usuario_e_gestao()` / flag; `RAISE EXCEPTION ... ERRCODE '42501'` quando negado).
- `EXECUTE` concedido **somente** aos perfis necessários — `REVOKE EXECUTE ... FROM anon, public` por padrão.
- Identidade sempre por `auth.email()/auth.uid()`, nunca por parâmetro do frontend.
- Sem SQL dinâmico inseguro; sem retornar PII desnecessária; proteção contra enumeração (limites + filtro por dono).

Uma RPC **não** pode confiar em: e-mail/operador enviado pelo frontend, filtro manipulável, ou route guard visual.

## 5. Grants

- `anon`: **nenhum** dado operacional. Revogar `EXECUTE` de RPCs sensíveis.
- `authenticated`: acesso mediado por RLS; nunca policy ampla.
- Evitar `GRANT ALL` herdado — preferir grants explícitos por tabela/coluna.
- `service_role`: só backend/Edge Function, **nunca** no navegador.

## 6. Views

- Preferir `security_invoker = true` (respeita a RLS de quem consulta).
- `security_invoker = off` só com justificativa **e sem grant a anon/authenticated**.
- Views de relatório global **não** podem ser SELECT de operador comum.

## 7. Dados pessoais (LGPD)

- CPF e telefone **mascarados** em telas gerais, relatórios e RPCs de lista.
- Documentos privados nunca por URL pública — **URL assinada com expiração**.
- Não retornar dados que a tela não usa; não logar CPF/telefone/token/documento completo.
- Ficha individual: dados completos só a perfis autorizados.

## 8. Storage

Buckets de termos, comprovantes, documentos, notas fiscais, fechamento, anexos financeiros: **privados**.
Obrigatório: policy por usuário/perfil, URL assinada com expiração, validação no backend,
nenhum link público permanente, nenhuma service_role no navegador.

## 9. Teste de perfis (obrigatório)

Simular `anon`, `authenticated` sem perfil, operador, Amanda ADM, Fernanda, Amanda gestora.
Validar leitura/inclusão/alteração/exclusão/RPC/view/arquivo + manipulação de parâmetros +
tentativa de acessar carteira alheia. **Testes de escrita em PROD sempre com `ROLLBACK`**,
salvo ação real expressamente autorizada.

Padrão de teste com rollback:
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","email":"cobrancaNN@aelbra.com.br"}',true);
-- ... asserção ...
rollback;
```

## 10. Checklist de migration

Toda migration que cria/substitui função, RPC, view, tabela, trigger, bucket, policy ou grant deve **repetir os testes de segurança**, mesmo que a feature já tenha sido validada. `CREATE OR REPLACE` pode restaurar grants padrão → **reconfirmar grants e `search_path`**.

## 11. Critérios de interrupção (Security Gate) — ver §12

## 12. Resposta a incidente

1. Conter (revogar grant/EXECUTE, tornar bucket privado, desabilitar RPC).
2. Registrar em `docs/seguranca/` com data, escopo e dados potencialmente expostos.
3. Avaliar dever de notificação (LGPD) com a gestão.
4. Corrigir com migration + testes de perfil; auditar regressões.

## 13. Rollback

Toda alteração sensível precisa de rollback seguro (backup da estrutura/dados afetados,
migration reversa preparada). Nenhuma demanda sensível recebe status ☑ só com teste funcional —
ver `CHECKLIST_SEGURANCA_DEPLOY.md`.

---

### Referência rápida de conclusão (§13)
Toda entrega sensível encerra informando: segurança validada · perfis testados · RLS validada ·
grants validados · RPCs validadas · dados pessoais mascarados · arquivos privados ·
alterações operacionais inesperadas: 0 · rollback preparado.
