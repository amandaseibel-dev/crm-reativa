# Resultado da auditoria do vínculo de retorno — 13/11/2026

Consulta: `supabase/audits/retorno_vinculo_auditoria_20261113.sql`, rodada tal como
versionada, em produção (`ahattpqrjmhkzsmnbdzs`), **somente leitura**.
Momento: **13/11/2026 09:04 BRT**, com 2 consultas ativas no banco (baixo tráfego).

A base é viva: estes números são um retrato e mudam a cada hora. Reproduzir é rodar
a mesma consulta de novo.

## Saída, tal como devolvida

| Bloco | Item | Valor |
|---|---|---|
| A | total | 850 |
| A | com retorno de operador vigente | 62 |
| A | protegidos SO pela via explicita | 0 |
| A | protegidos SO pela via alternativa (pergunta 2) | 0 |
| A | sem protecao: seriam liberados | 850 |
| A | com retorno de operador e SEM protecao (os "62"; pergunta 4) | 62 |
| B | elegiveis COM atendimento do responsavel nos ultimos 10 dias | 0 |
| B | destes, dias entre o atendimento e o ultimo acionamento do caso | (nenhum) |
| C | casos elegiveis protegidos entre o 11o e o 15o dia | 0 |
| D | total | 600 |
| D | responsavel INATIVO (nao protege, regra 5) | 11 |
| D | com vinculo EXPLICITO valido | 217 |
| D | SEM vinculo explicito, mas protegidos pela ALTERNATIVA | 177 |
| D | SEM vinculo explicito e SEM alternativa (nao protegidos) | 206 |

## Consulta complementar (mesma janela)

```sql
select count(*) filter (where c.operador_email is not null and coalesce(c.encerrado_operacional,false) = false) as casos_com_operador_ativos,
       count(*) filter (where c.operador_email is not null and coalesce(c.encerrado_operacional,false) = false
                          and public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)) as protegidos_fidelizacao_normal,
       count(*) filter (where c.operador_email is not null and coalesce(c.encerrado_operacional,false) = false
                          and public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)) as protegidos_giro_vigente
  from public.casos c;
```

| casos_com_operador_ativos | protegidos_fidelizacao_normal | protegidos_giro_vigente |
|---|---|---|
| 6183 | 4839 | 0 |

## Observação sobre a leitura

A consulta **repete o predicado da regra em SQL**, porque
`public.aluno_retorno_operador_vigente` ainda não existe em produção (migration
pendente). Depois de aplicada, o resultado tem de continuar batendo com a função —
é o que o teste de equivalência da suíte garante na bancada.
