// Filtro de período das filas do ADM (links de pagamento, financeiro e termos).
// Os atalhos (hoje/semana/mês) não têm fim: pegam tudo dali pra frente. O
// personalizado respeita as duas pontas, e cada ponta é opcional — dá pra
// filtrar só "de", só "até" ou o intervalo fechado.

export function intervaloPeriodo(periodo, dataDe, dataAte) {
  const agora = new Date();

  if (periodo === "PERSONALIZADO") {
    return {
      desde: dataDe ? new Date(`${dataDe}T00:00:00`) : null,
      ate: dataAte ? new Date(`${dataAte}T23:59:59.999`) : null,
    };
  }

  if (periodo === "HOJE") {
    agora.setHours(0, 0, 0, 0);
    return { desde: agora, ate: null };
  }

  if (periodo === "SEMANA") {
    const diaSemana = agora.getDay();
    agora.setDate(agora.getDate() - diaSemana);
    agora.setHours(0, 0, 0, 0);
    return { desde: agora, ate: null };
  }

  if (periodo === "MES") {
    agora.setDate(1);
    agora.setHours(0, 0, 0, 0);
    return { desde: agora, ate: null };
  }

  return { desde: null, ate: null };
}

// Data no formato que o <input type="date"> entende.
export function comoInputData(data) {
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${data.getFullYear()}-${mes}-${dia}`;
}

// O intervalo só é inválido quando as duas pontas existem e estão invertidas.
export function intervaloInvalido(periodo, dataDe, dataAte) {
  return periodo === "PERSONALIZADO" && Boolean(dataDe) && Boolean(dataAte) && dataDe > dataAte;
}
