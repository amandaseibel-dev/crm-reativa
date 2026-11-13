-- ============================================================================
-- ORIGEM DA DATA DE RETORNO DOS CASOS AMBIGUOS -- 13/11/2026
-- SOMENTE LEITURA. Nenhum UPDATE, nenhum DML.
--
-- Para que serve: os casos classificados como AMBIGUOS por
-- `supabase/audits/retorno_estoque_antigo_20261113.sql` ficam FORA da liberacao.
-- Esta consulta mede os SINAIS da data vigente desses casos, para que a decisao
-- da gestao sobre eles nao se apoie em suposicao.
--
-- O QUE ELA NAO FAZ: ela NAO prova quem gravou a data. Data vigente igual a hoje
-- somada a texto de atendimento apontando data ja vencida e um sinal COMPATIVEL
-- com o recalculo automatico investigado na PR #949; nao e prova de que a data e
-- automatica, porque nao ha grupo de controle medido de retornos sabidamente
-- humanos. Ler como sinal, nao como causa.
--
-- Os CTEs abaixo sao COPIA FIEL dos de retorno_estoque_antigo_20261113.sql --
-- mesmo universo, mesmo predicado de ambiguidade -- para que os numeros dos dois
-- arquivos sejam comparaveis linha a linha.
-- ============================================================================

with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),

elegivel as (
  select c.id as caso_id, c.aluno_id, c.cpf_limpo, lower(c.operador_email) as operador
    from public.casos_elegiveis_liberacao_fidelizacao() e
    join public.casos c on c.id = e.caso_id
   where c.aluno_id is not null
),

-- Retorno de operador vigente: hoje ou futuro, não concluído, responsável ativo.
retorno as (
  select a.id as aluno_id, lower(a.responsavel_atual_email) as resp, a.data_retorno as ret,
         a.responsavel_atual_em as resp_em,
         exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(a.responsavel_atual_email) and u.ativo) as resp_ativo
    from public.alunos a, hoje h
   where a.responsavel_atual_email is not null
     and a.data_retorno >= h.d
     and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
     and a.retorno_confirmado_em is null
),

sinal as (
  select r.*,
    -- vínculo pelo CAMPO (formato novo, a partir de 13/11)
    (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
       from public.aluno_movimentacoes m
      where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
        and lower(m.registrado_por_email) = r.resp
        and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
        and (m.data_retorno at time zone 'America/Sao_Paulo')::date = r.ret) as dia_campo,
    -- vínculo pelo TEXTO (estoque antigo)
    (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
       from public.aluno_movimentacoes m
      where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
        and lower(m.registrado_por_email) = r.resp
        and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
        and m.descricao like '%Retorno: ' || to_char(r.ret, 'DD/MM/YYYY') || '%') as dia_texto,
    -- alternativa: atendimento do responsável nos últimos 10 dias
    (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
       from public.aluno_movimentacoes m
      where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
        and lower(m.registrado_por_email) = r.resp
        and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
        and m.registrado_em >= now() - interval '10 days') as dia_alt,
    -- SINAL DE AMBIGUIDADE: o responsável menciona retorno, mas com OUTRA data
    exists (select 1 from public.aluno_movimentacoes m
             where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
               and lower(m.registrado_por_email) = r.resp
               and m.descricao ilike '%retorno%'
               and m.descricao not like '%Retorno: ' || to_char(r.ret, 'DD/MM/YYYY') || '%') as menciona_outra_data,
    -- SINAL DE AMBIGUIDADE: nenhum atendimento do responsável atual
    not exists (select 1 from public.aluno_movimentacoes m
                 where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
                   and lower(m.registrado_por_email) = r.resp) as sem_atendimento_do_resp
  from retorno r
),

classificado as (
  select s.*,
    (s.resp_ativo and s.dia_campo is not null and s.ret <= s.dia_campo + 15) as via_campo,
    (s.resp_ativo and s.dia_texto is not null and s.ret <= s.dia_texto + 15) as via_texto,
    (s.resp_ativo and s.dia_alt   is not null)                                as via_alt
  from sinal s
),

caso as (
  select e.*, c.aluno_id is not null as tem_retorno,
         coalesce(c.via_campo, false) as via_campo,
         coalesce(c.via_texto, false) as via_texto,
         coalesce(c.via_alt,   false) as via_alt,
         coalesce(c.menciona_outra_data, false) as menciona_outra_data,
         coalesce(c.sem_atendimento_do_resp, false) as sem_atendimento_do_resp,
         coalesce(c.resp_ativo, true) as resp_ativo
    from elegivel e
    left join classificado c on c.aluno_id = e.aluno_id
),

final as (
  select *,
    (via_campo or via_texto or via_alt) as protegido,
    -- AMBÍGUO: tem retorno de operador vigente, NÃO está protegido, mas há sinal
    -- de que houve agendamento humano que não dá para amarrar à data vigente.
    (tem_retorno and not (via_campo or via_texto or via_alt)
       and (menciona_outra_data or sem_atendimento_do_resp)) as ambiguo
  from caso
)

select 'AMBIGUOS' as bloco, 'casos' as item, count(*)::text as valor from final where ambiguo
union all select 'AMBIGUOS', 'alunos distintos', count(distinct aluno_id)::text from final where ambiguo

union all select 'SINAIS DA DATA VIGENTE', 'data_retorno = hoje (Sao Paulo)', count(*)::text
  from final f join public.alunos a on a.id = f.aluno_id, hoje h
 where f.ambiguo and a.data_retorno = h.d
union all select 'SINAIS DA DATA VIGENTE', 'data_retorno no futuro', count(*)::text
  from final f join public.alunos a on a.id = f.aluno_id, hoje h
 where f.ambiguo and a.data_retorno > h.d
-- NAO EXISTE sinal de "hora do agendamento": `alunos.data_retorno` e do tipo
-- `date` e nunca guardou hora. Qualquer leitura baseada em hora e vazia por
-- construcao -- conferido no catalogo em 13/11/2026.
union all select 'SINAIS DA DATA VIGENTE', 'valor exato de retorno_origem', a.retorno_origem || ' = ' || count(*)::text
  from final f join public.alunos a on a.id = f.aluno_id
 where f.ambiguo group by a.retorno_origem

union all select 'SINAIS DO TEXTO DO ATENDIMENTO', 'texto do responsavel cita data JA VENCIDA', count(*)::text
  from final f, hoje h
 where f.ambiguo and exists (
   select 1 from public.aluno_movimentacoes m, public.alunos a
    where a.id = f.aluno_id and m.aluno_id = f.aluno_id::text
      and m.tipo = 'FINALIZACAO_ATENDIMENTO'
      and lower(m.registrado_por_email) = lower(a.responsavel_atual_email)
      and m.descricao like '%Retorno: %'
      and to_date(substring(m.descricao from 'Retorno: (\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') < h.d)
union all select 'SINAIS DO TEXTO DO ATENDIMENTO', 'menor data citada no texto', coalesce(min(x.d)::text, '(nenhuma)')
  from final f, lateral (
   select to_date(substring(m.descricao from 'Retorno: (\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as d
     from public.aluno_movimentacoes m, public.alunos a
    where a.id = f.aluno_id and m.aluno_id = f.aluno_id::text
      and m.tipo = 'FINALIZACAO_ATENDIMENTO'
      and lower(m.registrado_por_email) = lower(a.responsavel_atual_email)
      and m.descricao like '%Retorno: %') x
 where f.ambiguo and x.d is not null
union all select 'SINAIS DO TEXTO DO ATENDIMENTO', 'maior data citada no texto', coalesce(max(x.d)::text, '(nenhuma)')
  from final f, lateral (
   select to_date(substring(m.descricao from 'Retorno: (\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as d
     from public.aluno_movimentacoes m, public.alunos a
    where a.id = f.aluno_id and m.aluno_id = f.aluno_id::text
      and m.tipo = 'FINALIZACAO_ATENDIMENTO'
      and lower(m.registrado_por_email) = lower(a.responsavel_atual_email)
      and m.descricao like '%Retorno: %') x
 where f.ambiguo and x.d is not null
order by 1, 2;
