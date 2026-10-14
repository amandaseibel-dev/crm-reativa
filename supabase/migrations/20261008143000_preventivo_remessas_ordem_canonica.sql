-- PREVENTIVO: o historico de remessas passa a sair na ordem da EXTRACAO.
--
-- A tela diz "da mais nova para a mais antiga", mas a funcao ordenava por
-- `criado_em` -- a hora em que o arquivo foi IMPORTADO. Sao coisas diferentes:
-- uma foto de 05/10 importada no dia 05 cai abaixo de uma foto de 02/10
-- importada no dia 07, e a lista desmente a propria legenda.
--
-- Foi o que aconteceu em producao: F4 (06/10) → F2 (05/10 manha) → F1 (02/10)
-- → F3 (05/10 tarde), com a F3 no fim por ter sido a unica importada antes.
--
-- A ordem certa ja existe e e a mesma que o painel usa: `preventivo_ordem`
-- (dia da extracao em America/Sao_Paulo, depois precisao, ordem declarada no
-- dia e, so como desempate de exibicao, criado_em e id). Aqui ela entra
-- decrescente.
--
-- NADA ALEM DISSO MUDA: mesma assinatura, mesmo conteudo por remessa, mesmas
-- comparacoes entre fotos -- elas ja usavam a ordem canonica e por isso
-- estavam certas mesmo com a lista fora de ordem.
do $$
declare
  v_def text := pg_get_functiondef('public.preventivo_remessas(uuid)'::regprocedure);
  v_de  text := 'order by l.criado_em desc';
  v_para text := 'order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, '
              || 'l.ordem_no_dia, l.criado_em, l.id) desc';
  v_novo text;
begin
  -- Idempotencia pelo texto NOVO: se a ordem canonica ja esta la, nao faz nada.
  if position(v_para in v_def) > 0 then
    return;
  end if;
  -- A ancora precisa existir e ser UNICA: duas ocorrencias significariam que o
  -- corpo mudou e que o replace acertaria um trecho que nao e este.
  if (length(v_def) - length(replace(v_def, v_de, ''))) / length(v_de) <> 1 then
    raise exception 'preventivo_remessas: ancora "%" ausente ou repetida -- a funcao mudou.', v_de;
  end if;
  v_novo := replace(v_def, v_de, v_para);
  if v_novo = v_def then
    raise exception 'preventivo_remessas: a substituicao nao alterou o corpo.';
  end if;
  execute v_novo;
end $$;

comment on function public.preventivo_remessas(uuid) is
  'Historico de remessas confirmadas da carteira, da extracao mais nova para a mais '
  'antiga pela ordem canonica (preventivo_ordem) -- nao pela hora da importacao.';
