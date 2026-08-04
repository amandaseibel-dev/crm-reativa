# CHECKLIST DE SEGURANÇA — DEPLOY (CRM ReATIVA)

Preencher em **toda** publicação. Copiar este bloco para a descrição do deploy/PR.
Base: `docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md`. Script: `scripts/seguranca/auditoria_seguranca.sql`.

```
DEPLOY: __________________________   DATA: ____/____/____   AUTOR: __________________
BRANCH/COMMIT: ____________________   AMBIENTE ALVO: [ ] staging  [ ] prod
```

## A. Gate automático (rodar o script de auditoria)
- [ ] `auditoria_seguranca.sql` executado no ambiente alvo
- [ ] Resultado anexado ao deploy
- [ ] **0** violações `BLOQUEIA` (qualquer uma interrompe a publicação)

## B. Critérios de INTERRUPÇÃO (qualquer item ⇒ gate reprovado)
- [ ] Nenhuma tabela **operacional** com RLS desligada
- [ ] Nenhum bucket sensível público
- [ ] Nenhum grant indevido para `public`/`anon`/`authenticated`
- [ ] Nenhuma RPC `SECURITY DEFINER` sem `search_path` fixo
- [ ] Nenhuma RPC com `EXECUTE` amplo **sem** autorização interna
- [ ] Operador **não** acessa outra carteira (tabela **e** view)
- [ ] Nenhum dado pessoal não mascarado em visão geral
- [ ] Nenhuma função nova restaurou grants amplos (checar após `CREATE OR REPLACE`)
- [ ] Nenhuma view com bypass de RLS acessível a operador
- [ ] `service_role` **ausente** do bundle
- [ ] Nenhuma referência ao Supabase de **staging** no bundle de produção
- [ ] Testes de segurança **passaram**
- [ ] Nenhuma alteração operacional inesperada

## C. Migration (se houver CREATE/REPLACE de função/RPC/view/tabela/trigger/bucket/policy/grant)
- [ ] Grants reconfirmados após `CREATE OR REPLACE`
- [ ] `search_path` fixo reconfirmado
- [ ] Autorização interna presente nas RPCs `SECURITY DEFINER`
- [ ] Rollback preparado (migration reversa / backup)

## D. Teste de perfis (com ROLLBACK)
| Perfil | Leitura | Escrita | RPC | Isolamento | OK |
|---|---|---|---|---|---|
| anon | | | | bloqueado | [ ] |
| authenticated sem perfil | | | | bloqueado | [ ] |
| operador | própria carteira | própria | gated | não vê alheio | [ ] |
| Amanda ADM (cobranca07) | | | | limitada | [ ] |
| Fernanda (cobranca04) | | | | limitada | [ ] |
| Amanda gestora (amanda.seibel) | | | | validada | [ ] |

## E. Dados pessoais / Storage
- [ ] CPF/telefone mascarados nas visões gerais
- [ ] RPCs de lista não retornam PII desnecessária
- [ ] Arquivos por URL assinada com expiração; buckets privados
- [ ] Nenhum CPF/telefone/token/documento em logs

## F. Conclusão (§13 da premissa)
```
SEGURANÇA VALIDADA: [ ]     PERFIS TESTADOS: [ ]     RLS VALIDADA: [ ]
GRANTS VALIDADOS: [ ]       RPCS VALIDADAS: [ ]      PII MASCARADA: [ ]
ARQUIVOS PRIVADOS: [ ]      ALTERAÇÕES OPERACIONAIS INESPERADAS: 0
ROLLBACK PREPARADO: [ ]
RESULTADO GATE:  [ ] ☑ APROVADO    [ ] ⚠ REPROVADO (risco: __________________)
```
