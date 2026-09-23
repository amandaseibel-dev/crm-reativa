-- ROLLBACK de 20260923170000_fila_pagamentos_filtra_antes_de_enriquecer.sql
--
-- Devolve `pagamentos_sem_aluno` ao corpo anterior -- o de 20260923160000,
-- copiado dali sem uma virgula de diferenca.
--
-- ATENCAO, E O MOTIVO DE ESTE ARQUIVO EXISTIR SO NO PAPEL: aquela versao e a
-- que estourava o `statement_timeout` de 8s do papel `authenticated` em
-- producao (29.308 ms medidos em 23/09/2026). Voltar para ela derruba a tela
-- "Pagamentos sem vinculo" de novo. So faz sentido como passo intermediario de
-- uma investigacao, nunca como estado final.
--
-- Nenhum dado e tocado: e troca de corpo de funcao, na mesma assinatura.

drop function if exists public.pagamentos_sem_aluno(text, boolean);

create or replace function public.pagamentos_sem_aluno(
  p_mes text default null::text, p_todos_os_meses boolean default false)
 returns table(
   pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
   titulo_numero text, numero_parcela_completo text, valor_pago numeric,
   valor_honorario numeric, operador_nome text, operador_email text,
   motivo text, candidatos integer, motivo_financeiro text, sugestoes jsonb,
   detectado_em timestamp with time zone, importacao_id uuid, arquivo_nome text,
   status_conciliacao text, tem_aluno boolean,
   acordo_identificado text, evidencias jsonb, saldo_total numeric, saldo_vencido numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- Preferir o motivo da conciliacao, que e o novo e o mais especifico;
    -- cair para o motivo da fila; e so entao dizer que a linha e anterior.
    coalesce(p.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome,
    p.status_conciliacao,
    (p.aluno_id is not null),
    -- ACORDO IDENTIFICADO: o prefixo de 6 digitos do boleto de acordo
    -- (5 + acordo + parcela). Fora do padrao de 11 digitos, nao ha prefixo.
    ev.prefixo,
    -- EVIDENCIAS: o que EXISTE hoje, em fato verificavel. Nenhuma inferencia,
    -- nenhuma sugestao de acao -- a tela mostra e quem decide e a gestao.
    jsonb_build_object(
      'acordo_prefixo',        ev.prefixo,
      'acordo_no_crm',         ev.acordo_no_crm,
      'acordo_status',         ev.acordo_status,
      'parcela_com_este_boleto', ev.parcela_existe,
      'parcela_status',        ev.parcela_status,
      'documento',             nullif(p.titulo_numero,''),
      'cpf_no_portador_166',   ev.no_166,
      'consulta_estrutura',    f.consulta_estrutura_resultado,
      'evidencia_origem',      f.evidencia_origem,
      'evidencia_em',          f.evidencia_em,
      'tentativas',            coalesce(f.quantidade_tentativas, 0),
      'primeira_tentativa_em', f.primeira_tentativa_em,
      'ultima_tentativa_em',   f.ultima_tentativa_em
    ),
    al.saldo_total,
    al.saldo_vencido
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  left join public.alunos al on al.id = p.aluno_id
  left join lateral (
    select
      pref.v as prefixo,
      (ac.id is not null) as acordo_no_crm,
      ac.status as acordo_status,
      (pa.id is not null) as parcela_existe,
      pa.status as parcela_status,
      exists (select 1 from public.prime_portador_membro m
               where m.portador = 166
                 and lpad(m.cpf, 11, '0')
                   = lpad(regexp_replace(coalesce(p.cpf,''), '\D', '', 'g'), 11, '0')
                 and coalesce(p.cpf,'') <> '') as no_166
    from (select case when length(coalesce(p.numero_parcela_completo,'')) = 11
                      then substring(p.numero_parcela_completo, 2, 6) end as v) pref
    left join public.acordos ac
      on ac.numero_ulbra is not null
     and lpad(ac.numero_ulbra, 6, '0') = pref.v
     and upper(coalesce(ac.status,'')) <> 'CANCELADO'
    left join public.parcelas pa
      on pa.boleto = nullif(ltrim(coalesce(p.numero_parcela_completo,''),'0'), '')
  ) ev on true
  where (p.aluno_id is null or f.pagamento_id is not null)
    -- ENCERRADA SAI DA FILA ATIVA (17/09/2026). Sem isto, a linha decidida
    -- volta a aparecer pelo `p.aluno_id is null` -- e encerrar nao resolveria
    -- nada para quem olha a tela.
    and not exists (select 1 from public.fila_pagamento_sem_vinculo fd
                     where fd.pagamento_id = p.id and fd.decisao is not null)
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$function$;

comment on function public.pagamentos_sem_aluno(text, boolean) is
  'Fila de pagamentos sem baixa, para a gestao conferir. Desde 23/09/2026 devolve tambem o acordo identificado pelo prefixo do boleto, as evidencias verificaveis (acordo no CRM, parcela com o boleto, CPF no portador 166, consulta de estrutura, tentativas) e o saldo do aluno -- tudo diagnostico, nenhum vinculo.';

revoke all on function public.pagamentos_sem_aluno(text, boolean) from public, anon;
grant execute on function public.pagamentos_sem_aluno(text, boolean) to authenticated, service_role;
