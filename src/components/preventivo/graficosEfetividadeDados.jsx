// PREPARO DOS DADOS DOS GRÁFICOS — fora do componente, para ser testável sem
// montar React e sem renderizar SVG.
//
// REGRA QUE MANDA AQUI: ação sem régua NÃO entra no gráfico. Sem envio
// confirmado, ou com envio mas sem remessa posterior, a taxa é `null` — e
// `null` não é zero. Desenhar 0% diria ao olho que a ação não funcionou,
// quando o que existe é ausência de medição. Essas ações saem numa lista de
// "aguardando", nomeadas pelo que falta.
//
// OS DOIS GRÁFICOS LEEM A MESMA FONTE: `preventivo_resultados_por_acao`. O
// agregado `preventivo_resultados_por_contexto` não traz taxa por ALUNOS (só
// por títulos), e a métrica principal pedida é por alunos — então o segundo
// gráfico soma os ACUMULADOS das ações de cada contexto/canal e divide no fim.
// Soma ponderada, não média de médias: uma ação de 10 alunos não pode pesar
// igual a uma de 8.000. Nenhuma conta nova de negócio: são as mesmas contagens
// que o banco já devolveu, agrupadas.

export const CONTEXTOS_ROTULO = {
  PROXIMO_VENCIMENTO: "Próximo ao vencimento",
  BOLETO_VENCIDO: "Boleto vencido",
  SEM_CONTEXTO: "Sem contexto",
};

export const CANAIS = ["WHATSAPP", "EMAIL"];
export const CANAIS_ROTULO = { WHATSAPP: "WhatsApp", EMAIL: "E-mail" };

// Por que a ação ficou sem medição. A ordem importa: falta de envio vem antes,
// porque é o degrau anterior do fluxo.
export function motivoSemRegua(l) {
  if (l?.sem_remessa) return "sem remessa vinculada";
  if (l?.aguardando_envio_confirmado) return "aguardando envio confirmado";
  if (l?.aguardando_proxima_remessa) return "aguardando próxima remessa";
  return null;
}

const temMedicao = (l) =>
  motivoSemRegua(l) === null
  && l.taxa_regularizacao_alunos !== null
  && l.taxa_regularizacao_alunos !== undefined;

export function dadosPorAcao(linhas) {
  const lista = Array.isArray(linhas) ? linhas : [];
  const medidas = [];
  const aguardando = [];

  for (const l of lista) {
    if (!temMedicao(l)) {
      aguardando.push({
        id: l.id, nome: l.nome, canal: l.canal, contexto: l.contexto,
        motivo: motivoSemRegua(l) || "sem medição",
      });
      continue;
    }
    medidas.push({
      id: l.id,
      nome: l.nome,
      canal: l.canal,
      contexto: l.contexto,
      taxa_alunos: Number(l.taxa_regularizacao_alunos),
      alunos_acionados: Number(l.alunos_acionados),
      alunos_regularizados: Number(l.alunos_regularizados),
      valor_acionado: l.valor_acionado,
      valor_regularizado: l.valor_regularizado,
      taxa_valor: l.taxa_regularizacao_valor,
    });
  }

  return { medidas, aguardando };
}

// Um grupo por contexto, uma série por canal. Só entra contexto/canal com ao
// menos uma ação medida.
export function dadosPorContextoCanal(linhas) {
  const { medidas, aguardando } = dadosPorAcao(linhas);
  const porCtx = new Map();

  for (const m of medidas) {
    if (!porCtx.has(m.contexto)) porCtx.set(m.contexto, new Map());
    const canais = porCtx.get(m.contexto);
    const atual = canais.get(m.canal) || {
      acoes: 0, acionados: 0, regularizados: 0,
      valor_acionado: 0, valor_regularizado: 0,
    };
    atual.acoes += 1;
    atual.acionados += m.alunos_acionados;
    atual.regularizados += m.alunos_regularizados;
    atual.valor_acionado += Number(m.valor_acionado || 0);
    atual.valor_regularizado += Number(m.valor_regularizado || 0);
    canais.set(m.canal, atual);
  }

  const grupos = [];
  for (const [ctx, canais] of porCtx) {
    const linha = { contexto: ctx, rotulo: CONTEXTOS_ROTULO[ctx] || ctx };
    for (const canal of CANAIS) {
      const a = canais.get(canal);
      if (!a || a.acionados === 0) continue;
      linha[canal] = Math.round((a.regularizados / a.acionados) * 1000) / 10;
      linha[`${canal}_dados`] = a;
    }
    grupos.push(linha);
  }

  grupos.sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR"));
  return { grupos, aguardando };
}
