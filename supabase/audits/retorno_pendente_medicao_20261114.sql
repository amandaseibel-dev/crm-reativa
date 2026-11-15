-- MEDICAO DA REGRA DE RETORNO DE 14/11/2026 -- producao, SOMENTE LEITURA (so SELECT).
-- Reproduz em SQL a regra vigente de aluno_retorno_operador_vigente (protecao) e a
-- retencao de aluno_retorno_ambiguo. A funcao ainda NAO existe em producao (migracao
-- pendente), por isso a regra e repetida aqui.
with pendentes as (
  select a.id as aluno_id, lower(a.responsavel_atual_email) as resp, a.responsavel_atual_em, a.data_retorno
    from public.alunos a
   where a.data_retorno is not null
     and upper(coalesce(a.retorno_origem,'')) like 'OPERADOR%'
     and a.retorno_confirmado_em is null
),
protegidos as (
  select p.aluno_id from pendentes p
   where p.resp is not null
     and exists (select 1 from public.aluno_movimentacoes m
                  where m.aluno_id = p.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
                    and lower(m.registrado_por_email) = p.resp
                    and m.registrado_em >= coalesce(p.responsavel_atual_em, '-infinity'::timestamptz)
                    and m.data_retorno is not null
                    and p.data_retorno <= (m.registrado_em at time zone 'America/Sao_Paulo')::date + 15)
)
select jsonb_build_object(
  'medido_em', to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),
  'retornos_pendentes_operador', (select count(*) from pendentes),
  'protegidos_por_registro_explicito', (select count(*) from protegidos),
  'retidos_sem_registro_explicito', (select count(*) from pendentes where aluno_id not in (select aluno_id from protegidos)),
  'retidos_com_responsavel_inativo', (select count(*) from pendentes p where aluno_id not in (select aluno_id from protegidos)
        and p.resp is not null and not exists (select 1 from public.usuarios u where lower(u.email)=p.resp and u.ativo)),
  'retidos_sem_responsavel', (select count(*) from pendentes p where aluno_id not in (select aluno_id from protegidos) and p.resp is null)
) as medicao;
