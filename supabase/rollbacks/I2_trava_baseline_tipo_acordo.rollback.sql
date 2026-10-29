-- ============================================================================
-- ROLLBACK da trava de cobertura de `TIPO=ACORDO`
--
-- Restaura `extracao_validar` ao corpo de produção de 07/10/2026:
--   md5(pg_get_functiondef(...)) = 4ca4c512fd0b0ad74185dc50e4908913
--   length = 2.588 chars
-- Conferir esse md5 ANTES de rodar: se não bater, produção mudou depois da
-- trava e restaurar este texto desfaria a mudança de outra pessoa.
--
-- Efeito: a trava de `TIPO=TODOS` volta a ser a única; `TIPO=ACORDO` volta a
-- poder ser validado à mão em qualquer tamanho. Zero DML -- nenhuma extração
-- muda de estado, nem aqui nem na ida.
-- ============================================================================

create or replace function public.extracao_validar(
  p_escopo_id uuid, p_decisao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_estado    text;
  v_e         public.extracao_escopo;
  v_universo  bigint;
  v_min       numeric := 0.50;   -- piso provisorio, calibravel por migration
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'Somente a gerencia pode validar um snapshot TOTAL: a validacao cria baseline.'
      using errcode = '42501';
  end if;
  if p_decisao not in ('VALIDAR','REPROVAR') then
    raise exception 'Decisão inválida: %', p_decisao using errcode = '22023';
  end if;

  -- ===== TRAVA DE VOLUME (so para VALIDAR, so para TIPO=TODOS) =============
  if p_decisao = 'VALIDAR' then
    select * into v_e from public.extracao_escopo where id = p_escopo_id;
    if v_e.id is not null
       and v_e.completude = 'TOTAL'
       and v_e.scope_key like '%TIPO=TODOS%' then
      select count(distinct t.documento) into v_universo
        from public.acordos_titulos t
       where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');
      if coalesce(v_e.titulos_distintos,0) < v_min * coalesce(v_universo,0) then
        raise exception
          'Volume incompativel com o escopo declarado TIPO=TODOS: o snapshot tem % titulos e o universo em aberto tem % (% por cento do universo; minimo % por cento). Marque PARCIAL ou REPROVAR.',
          coalesce(v_e.titulos_distintos,0), coalesce(v_universo,0),
          round(100.0*coalesce(v_e.titulos_distintos,0)/nullif(v_universo,0), 3),
          round(100*v_min,0)
          using errcode = '22023';
      end if;
    end if;
  end if;
  -- =========================================================================

  v_estado := case p_decisao when 'VALIDAR' then 'TOTAL_VALIDADO'
                             else 'TOTAL_REPROVADO' end;
  update public.extracao_escopo
     set estado = v_estado,
         validado_por = coalesce(auth.jwt() ->> 'email','desconhecido'),
         validado_em  = now(),
         validacao_motivo = coalesce(validacao_motivo,'{}'::jsonb)
           || jsonb_build_object('decisao_humana', p_decisao, 'motivo_humano', p_motivo)
   where id = p_escopo_id and completude = 'TOTAL'
     and estado = 'TOTAL_PENDENTE_VALIDACAO';
  if not found then
    raise exception 'Escopo % não está em TOTAL_PENDENTE_VALIDACAO.', p_escopo_id
      using errcode = '22023';
  end if;
  return jsonb_build_object('escopo_id', p_escopo_id, 'estado', v_estado);
end;
$$;
