-- Perf: importar_dados_academicos travava com "canceling statement due to
-- statement timeout" em lotes grandes (ex: 8.422 alunos), porque comparava cada
-- linha contra os ~17k alunos com unaccent a cada comparacao (O(linhas x alunos)).
--
-- Fix: (1) statement_timeout proprio de 300s na funcao (o papel authenticated tem
-- 8s); (2) snapshot normalizado dos alunos montado UMA vez por chamada em temp
-- table indexada (email/nome/cpf), e o casamento passa a usar os indices.
-- Mesma logica de vinculo (CPF -> email -> nome+estabelecimento) e mesmas regras
-- (so UPDATE, nunca INSERT; idempotente; nao casados viram pendencias).

create or replace function importar_dados_academicos(
  p_linhas jsonb,
  p_fonte text default 'relatorio_inadimplencia',
  p_arquivo text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
declare
  v_email     text := lower(coalesce(auth.jwt()->>'email',''));
  v_row       jsonb;
  v_cpf       text;
  v_nome      text;
  v_unid      text;
  v_curso     text;
  v_sit       text;
  v_codigo    text;
  v_ids       uuid[];
  v_id        uuid;
  v_total     int := 0;
  v_casados   int := 0;
  v_curso_upd int := 0;
  v_sit_upd   int := 0;
  v_pendentes jsonb := '[]'::jsonb;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then
    raise exception 'Acesso restrito à gestão';
  end if;

  create temp table _al_acad on commit drop as
    select id,
           lower(email)                                 as email_l,
           acad_norm_txt(nome)                          as nome_n,
           acad_norm_txt(unidade)                       as unid_n,
           regexp_replace(coalesce(cpf,''),'\D','','g') as cpf_d
    from alunos;
  create index on _al_acad(email_l);
  create index on _al_acad(nome_n);
  create index on _al_acad(cpf_d);

  for v_row in select value from jsonb_array_elements(coalesce(p_linhas,'[]'::jsonb))
  loop
    v_total  := v_total + 1;
    v_ids    := null;
    v_cpf    := regexp_replace(coalesce(v_row->>'cpf',''), '\D', '', 'g');
    v_nome   := acad_norm_txt(v_row->>'nome');
    v_unid   := acad_norm_txt(v_row->>'estabelecimento');
    v_curso  := nullif(btrim(v_row->>'curso'), '');
    v_sit    := nullif(btrim(v_row->>'situacao'), '');
    v_codigo := nullif(btrim(v_row->>'codigo'), '');

    if length(v_cpf) >= 11 then
      select array_agg(id) into v_ids from _al_acad where cpf_d = v_cpf;
    end if;

    if v_ids is null or array_length(v_ids,1) is null then
      with cand as (
        select distinct lower(btrim(e)) e
          from unnest(regexp_split_to_array(coalesce(v_row->>'email',''), '[;,\s]+')) e
         where e like '%@%'
      )
      select array_agg(distinct a.id) into v_ids
        from _al_acad a join cand c on a.email_l = c.e;
    end if;

    if (v_ids is null or array_length(v_ids,1) is null) and v_nome is not null then
      select array_agg(id) into v_ids
        from _al_acad
       where nome_n = v_nome
         and (v_unid is null or unid_n = v_unid);
    end if;

    if v_ids is not null and array_length(v_ids,1) = 1 then
      v_id := v_ids[1];
      update alunos set
        curso_real              = coalesce(v_curso, curso_real),
        situacao_academica      = coalesce(v_sit, situacao_academica),
        academico_codigo        = coalesce(v_codigo, academico_codigo),
        academico_fonte         = p_fonte,
        academico_atualizado_em = now()
      where id = v_id;
      v_casados := v_casados + 1;
      if v_curso is not null then v_curso_upd := v_curso_upd + 1; end if;
      if v_sit   is not null then v_sit_upd   := v_sit_upd   + 1; end if;
    else
      v_pendentes := v_pendentes || jsonb_build_object(
        'codigo',         v_codigo,
        'nome',           v_row->>'nome',
        'email',          v_row->>'email',
        'estabelecimento',v_row->>'estabelecimento',
        'curso',          v_curso,
        'situacao',       v_sit,
        'motivo', case when v_ids is null or array_length(v_ids,1) is null then 'nao_encontrado' else 'ambiguo' end
      );
    end if;
  end loop;

  drop table if exists _al_acad;

  insert into academico_importacoes(fonte, arquivo, total, casados, pendentes, criado_por)
  values (p_fonte, p_arquivo, v_total, v_casados, v_pendentes, v_email);

  return jsonb_build_object(
    'total', v_total, 'casados', v_casados,
    'curso_atualizado', v_curso_upd, 'situacao_atualizada', v_sit_upd,
    'pendentes', v_pendentes
  );
end;
$$;

revoke all on function importar_dados_academicos(jsonb, text, text) from public;
grant execute on function importar_dados_academicos(jsonb, text, text) to authenticated;
