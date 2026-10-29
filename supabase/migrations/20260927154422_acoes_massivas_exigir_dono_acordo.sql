-- ---------------------------------------------------------------------------
-- Campo de "Responsavel pelo acordo" VAZIO nao pode significar "acordo de
-- qualquer pessoa".
--
-- A LACUNA (deixada aberta por 20260927143351 / PR #537)
-- As duas dimensoes passaram a existir, mas a de ACORDO era opcional: sem
-- marcar nada, o universo nao recortava e voltava a entrar acordo de terceiro.
-- Medido em 27/09/2026: ~902 acordos de terceiros nas carteiras. O default
-- silencioso era justamente o caminho perigoso.
--
-- O QUE MUDA
-- Nas modalidades que olham acordo -- ACORDOS_VENCIDOS e MENSALIDADES_E_ACORDOS
-- -- passa a ser OBRIGATORIO pelo menos um responsavel pelo acordo. A exigencia
-- vale nos TRES caminhos que agem: previa, exportar e registrar.
--
-- MENSALIDADES segue sem a exigencia: essa modalidade nao olha acordo.
--
-- CHAMADA ANTIGA TAMBEM CAI. p_operador_email = 'todos', 'livres', um e-mail
-- solto ou vazio nao trazem dimensao de acordo -- e o tipo, quando ausente,
-- vale MENSALIDADES_E_ACORDOS por padrao em toda a cadeia. Logo, uma chamada
-- antiga a essas modalidades passa a ser RECUSADA com 22023, que e o ponto:
-- nao existe mais caminho silencioso para acionar acordo de terceiro.
--
-- ONDE A EXIGENCIA NAO ENTRA, DE PROPOSITO
-- No universo e no painel de cobertura. Os dois sao LEITURA e alimentam telas
-- que mostram o retrato da base; recusar ali cegaria o painel sem impedir
-- disparo nenhum. Quem age sao previa, exportar e registrar.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

do $pre$
begin
  if not exists (select 1 from pg_proc
                  where oid = 'public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text,text,text,integer,boolean)'::regprocedure
                    and prosrc like '%v_tem_sel%') then
    raise exception 'acoes_massivas_previa nao tem a selecao de responsavel -- aplique 20260927143351 antes desta.';
  end if;
end
$pre$;

-- A REGRA, em um lugar so: os tres caminhos chamam a MESMA funcao.
create or replace function internal.acao_massiva_donos_acordo(p_operador_email text)
returns text[]
language sql
immutable
as $fn$
  select case when position('ACORDO:' in upper(coalesce(btrim(p_operador_email), ''))) > 0
    then nullif(array(
      select lower(btrim(x))
        from unnest(string_to_array(
          substring(coalesce(btrim(p_operador_email), '')
                    from position('ACORDO:' in upper(coalesce(btrim(p_operador_email), ''))) + 7), '|')) x
       where nullif(btrim(x), '') is not null), '{}'::text[]) end;
$fn$;

comment on function internal.acao_massiva_donos_acordo(text) is
  'Os responsaveis PELO ACORDO dentro de p_operador_email (sintaxe CASO:..;ACORDO:..). NULL quando nenhum foi escolhido.';

create or replace function internal.acao_massiva_exigir_dono_acordo(p_tipo text, p_operador_email text)
returns void
language plpgsql
immutable
as $fn$
declare
  -- o mesmo default de toda a cadeia: tipo ausente vale MENSALIDADES_E_ACORDOS
  v_t text := upper(coalesce(nullif(btrim(p_tipo), ''), 'MENSALIDADES_E_ACORDOS'));
begin
  -- MENSALIDADES nao olha acordo: segue sem exigencia
  if v_t not in ('ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') then
    return;
  end if;

  if internal.acao_massiva_donos_acordo(p_operador_email) is null then
    raise exception
      'A modalidade % exige pelo menos um "Responsavel pelo acordo". Campo vazio NAO significa acordo de qualquer pessoa -- escolha de quem sao os acordos que voce quer acionar.',
      v_t
      using errcode = '22023';
  end if;
end;
$fn$;

comment on function internal.acao_massiva_exigir_dono_acordo(text,text) is
  'Recusa acao massiva de acordo sem dono explicito. Usada por previa, exportar e registrar -- os tres caminhos que agem.';

revoke all on function internal.acao_massiva_donos_acordo(text) from public, anon, authenticated;
revoke all on function internal.acao_massiva_exigir_dono_acordo(text,text) from public, anon, authenticated;
grant execute on function internal.acao_massiva_donos_acordo(text) to service_role;
grant execute on function internal.acao_massiva_exigir_dono_acordo(text,text) to service_role;

-- (1) PREVIA
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$  -- RECORTE EXPLICITO OBRIGATORIO na sintaxe nova: 'CASO:' sem nenhum e-mail
  -- disparia sobre a base inteira. Recusa alto em vez de assumir.
  if v_tem_sel and v_rc is null then$ancora$,
$novo$  -- Campo de acordo VAZIO nao e "qualquer pessoa": nas modalidades que olham
  -- acordo, escolher de quem e o acordo e obrigatorio. Vale tambem para
  -- chamada antiga ('todos', e-mail solto, vazio), que nao traz a dimensao.
  perform internal.acao_massiva_exigir_dono_acordo(p_tipo_cobranca, p_operador_email);

  -- RECORTE EXPLICITO OBRIGATORIO na sintaxe nova: 'CASO:' sem nenhum e-mail
  -- disparia sobre a base inteira. Recusa alto em vez de assumir.
  if v_tem_sel and v_rc is null then$novo$,
  1);

-- (2) EXPORTAR
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_exportar',
$ancora$    raise exception 'Acesso negado: exportar acao massiva restrito a gestao.' using errcode = '42501';
  end if;$ancora$,
$novo$    raise exception 'Acesso negado: exportar acao massiva restrito a gestao.' using errcode = '42501';
  end if;

  -- mesma exigencia da previa, pela mesma funcao: exportar e um caminho que age
  perform internal.acao_massiva_exigir_dono_acordo(p_tipo_cobranca, p_operador_email);$novo$,
  1);

-- (3) REGISTRAR / DISPARO
select internal.patch_funcao_ancorada(
  'public', 'registrar_acao_massiva',
$ancora$    raise exception 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' using errcode = '42501';
  end if;$ancora$,
$novo$    raise exception 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' using errcode = '42501';
  end if;

  -- o tipo vem dos filtros gravados no lote; ausente, vale
  -- MENSALIDADES_E_ACORDOS, que exige o dono do acordo.
  perform internal.acao_massiva_exigir_dono_acordo(
    coalesce(p_filtros, '{}'::jsonb) ->> 'tipo_cobranca', p_operador_email);$novo$,
  1);
