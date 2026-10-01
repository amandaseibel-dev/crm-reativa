-- Rollback de 20260927160000: a previa volta a repetir a regra de destino
-- inline, e a lista carteira_geral_acordos_destinos deixa de existir.
--
-- ATENCAO: reverter NAO tira a Carteira Geral dos destinos -- o corpo antigo da
-- previa ja a aceitava. O que reverter faz e:
--   1. devolver a duplicacao da regra (tela e RPC podendo divergir de novo);
--   2. derrubar a tela publicada, que chama carteira_geral_acordos_destinos e
--      passaria a receber 42883 -- o seletor de destino ficaria vazio.
-- Reverter so faz sentido junto com a reversao do front.
--
-- Nenhum dado e movido aqui.

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_acordos_previa',
$ancora$  -- MESMA regra da lista de destinos, pela MESMA funcao: operador ATIVO ou a
  -- Carteira Geral. Repetir a regra aqui foi o que deixou a tela divergir.
  if not internal.acordo_destino_valido(v_destino) then
    raise exception
      'Destino invalido: %. So operador ATIVO ou a Carteira Geral podem receber acordo.',
      coalesce(nullif(btrim(coalesce(p_destino_email,'')),''), '(vazio)')
      using errcode = '22023';
  end if;

  select u.nome into v_destino_nome from public.usuarios u where lower(u.email) = v_destino;
  v_destino_nome := coalesce(v_destino_nome,
    case when v_destino = internal.carteira_geral_email() then 'Carteira Geral' else v_destino end);$ancora$,
$novo$  if v_destino = internal.carteira_geral_email() then
    v_destino_nome := 'CARTEIRA GERAL';
  else
    select u.nome into v_destino_nome from public.usuarios u
     where lower(u.email) = v_destino and u.ativo and u.perfil = 'operador';
    if v_destino_nome is null then
      raise exception 'Destino invalido ou operador inativo: %', p_destino_email;
    end if;
  end if;$novo$,
  1);

drop function if exists public.carteira_geral_acordos_destinos();
drop function if exists internal.acordo_destino_valido(text);
